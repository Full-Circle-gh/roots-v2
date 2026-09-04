// Materials (物料) — the tenant-facing name for stocked things a business buys
// and holds but does not sell: food, packaging, equipment, supplies.
//
// docs/tacet-consolidation-decisions.md §28 decided this is a MODULE inside
// Tacet, built by generalising the kitchen machinery rather than rebuilding on
// retail rails. So these routes read and write the SAME `ingredients` table the
// kitchen app writes — one masterlist, two doors. What changes is the door:
// requireRetailAdmin (multi-tenant operator gate) instead of requireAuth
// (single-tenant kitchen gate).
//
// SCHEMA NAMES ARE NOT RENAMED (§28): the table stays `ingredients`, the column
// stays `item_kind`. Only what a tenant reads says "Materials".
//
// NOTE (multi-tenant): `ingredients` has no tenant_id column and none is added
// here — the same deferral routes/retail-purchasing.js already carries for
// suppliers / purchase_orders. Roots is the only live tenant today.
//
// Purchase LINES for materials are not here — a retail PO carrying a material
// line lives entirely in routes/retail-purchasing.js (po_line_items.ingredient_id
// as the alternative to store_product_id, mutually exclusive). Shipped as
// Phase 1b (§28 addendum item 2); a material can still also be bought through
// the kitchen PO flow, unchanged.

const express = require('express');
// Per-tenant connection, for EVERY read and write in this file — the cost path
// always used it; the list, the detail and the archive route did not, and an
// archive is a write. `ingredients`, `ingredient_price_history` and
// `price_alerts` are data-plane tables with no tenant_id column
// (lib/tenant-db.js CONTROL_PLANE_TABLES lists what is shared, and none of
// these are on it), so under data isolation they live in the tenant's own DB
// and the global handle is Roots' masterlist. Every write on the COST path
// below therefore goes through tdb() — the same handle lib/product-cost.js's
// header names as the only correct one ("never the global handle, or a
// non-Roots tenant reads Roots' catalogue"). For Roots, tdb() IS the global
// handle, so nothing about the live install changes.
const { tdb } = require('../lib/tenant-db');
// The one cost derivation, shared with the kitchen form and the PO write-back.
// Never re-implement this maths — a second copy is what stored a pack price as
// a per-gram cost.
const { deriveCostPerUnit } = require('../lib/ingredient-cost');
// Finance category text — the one normalisation. See lib/category-text.js.
const { storeCategory } = require('../lib/category-text');
const { requireRetailAdmin } = require('./retail');
// The nested-recipe recompute (§29 step 3) — fired after a cost change on a
// non-linked material, since that can move a linked material's
// recipe-derived cost transitively. See lib/recipe-rollup.js.
const { fireRecompute, costOneRecipe } = require('../lib/recipe-rollup');
// §29 step 6 — the recipes currently consuming a material, for the
// archive-warning; shared with routes/retail-recipes.js's own use of the
// same query on the other side of this relationship.
const { materialConsumers } = require('../lib/recipe-materialize');
// Automatic SKUs (Settings → SKU codes). The create below asks it for a code
// when the operator left the field blank; routes/sku.js is the settings door
// onto the same two libraries.
const skuRules = require('../lib/sku-rules');

const router = express.Router();

// ── Who may read what a material COSTS (Ash, 2026-09-03) ─────────────────────
//
// `materials:view` opens the masterlist; `materials:costs` reads the two money
// columns on it — Buy price and Cost per unit. They were one capability, so the
// warehouse and store_manager presets read what every supplier charges and the
// cost basis of every margin in the business.
//
// ENFORCED HERE, ON THE WIRE, for the same reason routes/retail-waste.js is: a
// screen that hides a number it was sent is a screen, not a permission — the
// figure is still in the JSON. Same three rules as waste, deliberately, so the
// two read alike:
//   • FAILS CLOSED. Everywhere else a null cap set means "unknown, allow";
//     money inverts that trade.
//   • Keys are DELETED, not zeroed — a 0 buy price reads as free.
//   • It refuses a FIELD, never a request; nobody is 403'd for lacking it.
function canSeeCosts(req) {
  return !!(req.caps && req.caps.has && req.caps.has('materials:costs'));
}
// The two money columns on a material row, wherever a row is returned.
function stripMaterialCost(row) {
  if (!row) return row;
  const out = { ...row };
  delete out.cost_per_unit;
  delete out.buy_price;
  return out;
}

// Mirrors routes/ingredients.js's list projection: the two base64 columns
// (image_data, supplier_qr_data) stay out of a list payload and are exposed as
// boolean flags instead. The record GET below returns the whole row.
const LIST_COLS = `
  id, name_en, name_cn, sku, category,
  unit, buy_unit, buy_pack_size, pack_contents_qty, pack_contents_unit,
  cost_per_unit, buy_price, free_by_design,
  supplier, supplier_platform, supplier_link,
  allergens, notes,
  is_active, created_at, updated_at,
  accounting_category, item_kind, source_recipe_id,
  (image_data IS NOT NULL AND image_data != '')             AS has_image,
  (supplier_qr_data IS NOT NULL AND supplier_qr_data != '') AS has_supplier_qr
`;

// A UNIQUE violation on `sku` is reachable in a way that looks like a bug from
// the operator's side: archiving KEEPS the code (§18), so the row holding it may
// be one they cannot see in any list. Same explanation the kitchen half gives.
function skuClash(sku, excludeId) {
  if (!sku) return { error: 'sku_taken', message: 'SKU already exists' };
  const owner = excludeId
    ? tdb().prepare('SELECT id, name_en, name_cn, is_active FROM ingredients WHERE sku = ? AND id != ?').get(sku, excludeId)
    : tdb().prepare('SELECT id, name_en, name_cn, is_active FROM ingredients WHERE sku = ?').get(sku);
  if (!owner) return { error: 'sku_taken', message: 'SKU already exists' };
  return {
    error: 'sku_taken',
    message: owner.is_active
      ? `SKU "${sku}" is already used by "${owner.name_en}" (#${owner.id}).`
      : `SKU "${sku}" belongs to an archived material ("${owner.name_en}", #${owner.id}). `
        + 'Archived codes are kept on purpose so old orders and reports keep pointing at the right thing.',
    conflict: { id: owner.id, name_en: owner.name_en, name_cn: owner.name_cn, is_active: owner.is_active },
  };
}

// The body fields a material carries. Listed once so create and update cannot
// drift apart — the failure mode where a save silently blanks a field the other
// handler knew about.
function readBody(b) {
  return {
    name_en: b.name_en, name_cn: b.name_cn || null, sku: (b.sku || '').trim() || null,
    category: b.category || null,
    unit: b.unit || 'g', buy_unit: b.buy_unit || 'kg',
    buy_pack_size: b.buy_pack_size || 1,
    pack_contents_qty: b.pack_contents_qty || null,
    pack_contents_unit: b.pack_contents_unit || null,
    buy_price: Number(b.buy_price) || 0,
    supplier: b.supplier || null,
    allergens: Array.isArray(b.allergens) ? b.allergens.join(', ') : (b.allergens || null),
    notes: b.notes || null,
    accounting_category: storeCategory(tdb(), b.accounting_category),
    item_kind: b.item_kind || 'food',
    free_by_design: b.free_by_design ? 1 : 0,
  };
}

// cost_per_unit is DERIVED, never taken from the client. deriveCostPerUnit
// returns null when no divisor can be defended — and null means write nothing,
// not zero: storing 0 would erase a good cost.
//
// A material linked to the recipe that makes it (§29) is derived from that
// recipe instead, by the recompute pass — not from a buy price it does not
// really have. Editing pack size or buy price on such a row must leave its
// cost alone rather than quietly re-deriving it from purchase fields that
// mean nothing for a made thing.
function costFor(row, existingCpu) {
  if (row && row.source_recipe_id) return existingCpu || 0;
  const { cpu } = deriveCostPerUnit(row, row.buy_price);
  return cpu === null ? (existingCpu || 0) : cpu;
}

// ═══ List ══════════════════════════════════════════════════════════════════
router.get('/api/retail-admin/materials', requireRetailAdmin, (req, res) => {
  const { search, kind, category, supplier, archived, for_recipe, source } = req.query;
  // Everything EXCEPT the kind filter. The chip row is the kind filter, so its
  // counts have to be taken with every other filter applied and this one not —
  // otherwise a chip reads "Packaging 146" next to a searched table showing two
  // rows, and the number is describing a set the operator cannot see.
  let where = ' WHERE is_active = ?';
  const base = [archived === '1' ? 0 : 1];
  if (search)   { where += ' AND (name_en LIKE ? OR name_cn LIKE ? OR sku LIKE ?)'; const s = `%${search}%`; base.push(s, s, s); }
  if (category) { where += ' AND category = ?'; base.push(category); }
  if (supplier) { where += ' AND supplier = ?'; base.push(supplier); }
  // for_recipe=1 — the recipe line picker's eligibility filter (§29). Not the
  // kitchen picker's plain item_kind='food': packaging is deliberately left
  // out of BOTH clauses on the OR (not folded into the generic 'food'/'other'
  // allow-list) because recipe_cost_data.packaging (routes: PUT
  // /:id/cost) already prices packaging from the standalone packaging_types
  // table — there is no link between that table and `ingredients`, so an
  // item_kind='packaging' material appearing here too would give a jar two
  // uncoordinated cost paths into the same recipe, one of them silent.
  // 'equipment'/'retail' are excluded as structurally not a recipe input,
  // matching the kitchen picker's existing intent. A made material
  // (source_recipe_id set) is always eligible regardless of its own kind —
  // §29's whole point is that a bulk sauce used in another recipe must be
  // pickable, independent of how it happens to be tagged.
  if (for_recipe === '1') {
    where += ` AND (COALESCE(item_kind,'food') IN ('food','other') OR source_recipe_id IS NOT NULL)`;
  }

  // source=bought|made — the two jobs this one table does, told apart by the
  // only fact that distinguishes them: whether a recipe produces the row.
  // 'bought' is what Ash purchases and re-orders; 'made' is what
  // ensureMaterialized() files under Kitchen Recipes because a build line has
  // to be able to point at a cooked thing's cost. Mixing them is why two rows
  // for the same dates read as a bug rather than as one bought item and one
  // kitchen output. Absent (or any other value) means both, which is what
  // every existing caller sends and therefore still gets.
  //
  // NOT applied to the pickers below. The build-list and recipe-line pickers
  // must keep seeing every row whatever this list is showing — a filter on a
  // screen must never be able to make a material uncostable.
  const sourceClause = source === 'made' ? ' AND source_recipe_id IS NOT NULL'
    : source === 'bought' ? ' AND source_recipe_id IS NULL'
    : '';
  const kindClause = kind ? ' AND COALESCE(item_kind,\'food\') = ?' : '';

  const rows = tdb().prepare(
    `SELECT ${LIST_COLS} FROM ingredients${where}${sourceClause}${kindClause} ORDER BY name_en COLLATE NOCASE`
  ).all(...base, ...(kind ? [kind] : []));
  for (const r of rows) {
    r.has_image = !!r.has_image;
    r.has_supplier_qr = !!r.has_supplier_qr;
  }
  // Each count set is taken with every other filter applied and its own not —
  // the rule the kind chips already followed, now that there are two of them.
  // A chip reading "Packaging 146" beside a two-row table is describing a set
  // the operator cannot see, and a source tab reading "Made 122" while the
  // Packaging chip is on would be doing the same thing.
  const counts = tdb().prepare(
    `SELECT COALESCE(item_kind,'food') AS k, COUNT(*) AS n FROM ingredients${where}${sourceClause} GROUP BY 1`
  ).all(...base);
  const byKind = {};
  for (const c of counts) byKind[c.k] = c.n;
  const srcRow = tdb().prepare(
    `SELECT SUM(source_recipe_id IS NULL) AS bought, SUM(source_recipe_id IS NOT NULL) AS made
       FROM ingredients${where}${kindClause}`
  ).get(...base, ...(kind ? [kind] : []));
  const hideCost = !canSeeCosts(req);
  res.json({
    success: true, data: hideCost ? rows.map(stripMaterialCost) : rows, counts: byKind,
    sourceCounts: { bought: (srcRow && srcRow.bought) || 0, made: (srcRow && srcRow.made) || 0 },
    ...(hideCost ? { costs_hidden: true } : {}),
  });
});

// ═══ Pickers ═══════════════════════════════════════════════════════════════
// The kitchen serves these from routes/lookups.js behind requireAuth, which a
// backend operator does not hold. Same table, this realm's gate.
router.get('/api/retail-admin/materials/meta/kinds', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare(
    "SELECT name FROM categories WHERE kind = 'item_kind' ORDER BY sort_order, name"
  ).all();
  res.json({ success: true, data: rows.map(r => r.name) });
});

router.get('/api/retail-admin/materials/meta/categories', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare(
    "SELECT DISTINCT category FROM ingredients WHERE category IS NOT NULL AND TRIM(category) != '' ORDER BY category COLLATE NOCASE"
  ).all();
  res.json({ success: true, data: rows.map(r => r.category) });
});

// The finance-category master list — same `categories` rows the kitchen app's
// Finance page maintains (kind='accounting'). storeCategory() already snaps a
// typed value onto one of these; this just lets the field offer them instead
// of asking the operator to retype one from memory.
router.get('/api/retail-admin/materials/meta/accounting-categories', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare(
    "SELECT name FROM categories WHERE kind = 'accounting' ORDER BY sort_order, name"
  ).all();
  res.json({ success: true, data: rows.map(r => r.name) });
});

// ═══ One material ══════════════════════════════════════════════════════════
router.get('/api/retail-admin/materials/:id', requireRetailAdmin, (req, res) => {
  const row = tdb().prepare('SELECT * FROM ingredients WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  // Base64 payloads stay out of the detail read, same as the supplier detail.
  const hasImage = !!row.image_data, hasQr = !!row.supplier_qr_data;
  delete row.image_data; delete row.supplier_qr_data;
  row.has_image = hasImage; row.has_supplier_qr = hasQr;

  const priceHistory = tdb().prepare(
    'SELECT id, price, buy_unit, source, notes, recorded_at, recorded_by FROM ingredient_price_history WHERE ingredient_id = ? ORDER BY recorded_at DESC LIMIT 20'
  ).all(row.id);

  // Bought in — BOTH doors. Phase 1b (§28 addendum item 2) let a retail PO
  // carry a material line (routes/retail-purchasing.js), so this can no
  // longer filter to scope='kitchen' only — a material bought through Roots'
  // online-store purchasing needs to show up here too. po_number's own prefix
  // (PO- vs RPO-) already tells the two apart, so no extra column is needed.
  const purchases = tdb().prepare(`
    SELECT po.id AS po_id, po.po_number, po.date, po.status, po.supplier,
           pli.qty, pli.unit, pli.cost_per_unit, pli.total_cost
      FROM po_line_items pli
      JOIN purchase_orders po ON po.id = pli.po_id
     WHERE pli.ingredient_id = ?
     ORDER BY po.date DESC, po.id DESC
     LIMIT 20
  `).all(row.id);

  // What the stored cost would be if it were re-derived right now, and WHY —
  // the reason is what lets the form say "no pack contents recorded" instead of
  // showing a blank where a number should be.
  const derived = deriveCostPerUnit(row, row.buy_price);

  // §29 step 6 — two things the record must SHOW, not just have correct in
  // the data (docs/tacet-consolidation-decisions.md §29's "flagged stale"
  // promise is only real if a person can see it):
  //   usedByRecipes: active recipes consuming this material as an ingredient
  //     line — feeds the archive-warning ("used by N recipes").
  //   sourceRecipe / sourceRecipeBlock: when this row IS a made material
  //     (source_recipe_id set), the recipe that makes it and whether that
  //     recipe's own rollup is currently blocked — reusing costOneRecipe
  //     (lib/recipe-rollup.js), the exact function the rollup itself calls,
  //     so this can never say something the rollup would disagree with.
  //     null/null when this row is an ordinary purchased material.
  const usedByRecipes = materialConsumers(tdb(), row.id);
  let sourceRecipe = null, sourceRecipeBlock = null;
  if (row.source_recipe_id) {
    sourceRecipe = tdb().prepare('SELECT id, name_en, name_cn, is_active FROM recipes WHERE id = ?').get(row.source_recipe_id);
    if (sourceRecipe) {
      const r = costOneRecipe(tdb(), sourceRecipe.id, new Map());
      sourceRecipeBlock = { ok: r.ok, reason: r.ok ? null : r.reason, unpriced: r.unpriced || 0 };
    }
  }

  // FOUR money payloads on one response, and all four go. The row's own two
  // columns are the obvious pair; the other two are the ones a reading of the
  // screen alone would miss — `priceHistory` is a list of past buy prices and
  // `purchases` is what was paid on each PO line. `derived` is the recomputed
  // cost per unit, so its `cpu` goes — but `reason` and `gramsPerBuyUnit` stay.
  // Those are pack arithmetic and data quality, not money: "no pack contents
  // recorded" is exactly what an editor without prices still needs to fix, and
  // hiding it would make the form unusable for the person most likely to be
  // holding the sack.
  if (!canSeeCosts(req)) {
    return res.json({
      success: true, costs_hidden: true,
      data: stripMaterialCost(row),
      priceHistory: [],
      purchases: purchases.map(p => { const o = { ...p }; delete o.cost_per_unit; delete o.total_cost; return o; }),
      derived: derived ? { gramsPerBuyUnit: derived.gramsPerBuyUnit, reason: derived.reason } : derived,
      usedByRecipes, sourceRecipe, sourceRecipeBlock,
    });
  }
  res.json({ success: true, data: row, priceHistory, purchases, derived, usedByRecipes, sourceRecipe, sourceRecipeBlock });
});

// ═══ Create ════════════════════════════════════════════════════════════════
router.post('/api/retail-admin/materials', requireRetailAdmin, (req, res) => {
  const b = readBody(req.body || {});
  if (!b.name_en) return res.status(400).json({ success: false, error: 'name_required' });
  // Same rule as the update, and the same reason. There is no stored value to
  // carry through on a create, so the new material simply starts without a
  // price — which is the honest outcome: somebody who cannot be shown a price
  // was never in a position to set one, and the row reads "no price" until
  // somebody who can fills it in.
  if (!canSeeCosts(req)) b.buy_price = 0;
  try {
    // ── The automatic SKU (Ash, 2026-09-04) ─────────────────────────────────
    //
    // ONLY WHEN THE FIELD IS BLANK. A typed code always wins: a supplier's own
    // article number, a code carried over from a spreadsheet, or a scheme the
    // tenant runs by hand are all reasons to override, and the form flags a
    // mismatch rather than refusing one. Existing materials are never
    // renumbered — this runs on create, and on nothing else.
    //
    // CLAIMED INSIDE THE TRANSACTION BELOW, not before it. The counter advance
    // and the row insert have to commit together: claim outside and a save that
    // fails its UNIQUE check (or throws for any other reason) would leave a
    // number burned and a gap in the series that nobody can explain.
    //
    // A refusal is not an error. peek/claim answer {ok:false} when the tenant
    // has switched numbering off or no rule matches, and the material is then
    // saved with the blank SKU it arrived with — exactly as it was before this
    // existed.
    let autoSku = null;
    const write = tdb().transaction(() => {
      if (!b.sku) {
        const claimed = skuRules.claim(tdb(), 'material', {
          category: b.item_kind, subcategory: b.category, name: b.name_en,
        });
        if (claimed.ok) { b.sku = claimed.sku; autoSku = claimed.sku; }
      }
      const r = tdb().prepare(`INSERT INTO ingredients
        (name_en,name_cn,sku,category,unit,buy_unit,buy_pack_size,pack_contents_qty,pack_contents_unit,
         cost_per_unit,buy_price,supplier,allergens,notes,accounting_category,item_kind,free_by_design)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(b.name_en, b.name_cn, b.sku, b.category, b.unit, b.buy_unit, b.buy_pack_size,
             b.pack_contents_qty, b.pack_contents_unit,
             costFor(b, 0), b.buy_price, b.supplier, b.allergens, b.notes,
             b.accounting_category, b.item_kind, b.free_by_design);
      // A starting price is a price. The kitchen create logs one the same way, so
      // a material added from either door has the same first history row.
      if (b.buy_price > 0) {
        tdb().prepare('INSERT INTO ingredient_price_history (ingredient_id,price,buy_unit,source,recorded_by) VALUES (?,?,?,?,?)')
          .run(r.lastInsertRowid, b.buy_price, b.buy_unit, 'manual', (req.user && req.user.username) || 'backend');
      }
      return r;
    });
    const r = write();
    // `sku` goes back so the form can show the code the server actually issued
    // — the preview it displayed was a peek, and a concurrent save may have
    // taken that number in between.
    res.json({ success: true, id: r.lastInsertRowid, sku: b.sku || null, sku_auto: autoSku });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(400).json({ success: false, ...skuClash(b.sku, null) });
    res.status(500).json({ success: false, error: 'save_failed', message: e.message });
  }
});

// ═══ Update ════════════════════════════════════════════════════════════════
router.put('/api/retail-admin/materials/:id', requireRetailAdmin, (req, res) => {
  // Read through tdb() too: this row's stored cost_per_unit is what costFor()
  // preserves for a made material and what the recompute check below compares
  // against, so reading it from a different database than the one written to
  // would decide both from another tenant's figure.
  const existing = tdb().prepare('SELECT * FROM ingredients WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, error: 'not_found' });
  const b = readBody(req.body || {});
  if (!b.name_en) b.name_en = existing.name_en;
  if (!b.item_kind) b.item_kind = existing.item_kind || 'food';
  // YOU CANNOT CHANGE WHAT YOU CANNOT SEE — and this is data loss, not just a
  // permission. The editor omits the Buy price field for an operator without
  // materials:costs, readBody() turns an absent field into 0, and the UPDATE
  // below writes it unconditionally: renaming a material would have wiped its
  // price, written a price-history row saying so, and fired a >5% alert.
  // Carrying the stored value through is what keeps an edit of the NAME an
  // edit of the name. costFor() re-derives cost_per_unit from this, so the
  // derived cost is preserved with it.
  if (!canSeeCosts(req)) b.buy_price = existing.buy_price;
  try {
    // readBody() deliberately never reads source_recipe_id from the client —
    // a link is not something a material save gets to set — so the stored
    // value is carried in here for costFor()'s guard to see. Captured once so
    // the same number both gets written and drives the recompute check below.
    const writtenCpu = costFor({ ...b, source_recipe_id: existing.source_recipe_id }, existing.cost_per_unit);
    tdb().prepare(`UPDATE ingredients SET
      name_en=?,name_cn=?,sku=?,category=?,unit=?,buy_unit=?,buy_pack_size=?,
      pack_contents_qty=?,pack_contents_unit=?,cost_per_unit=?,buy_price=?,supplier=?,
      allergens=?,notes=?,accounting_category=?,item_kind=?,free_by_design=?,
      updated_at=CURRENT_TIMESTAMP
      WHERE id=?`)
      .run(b.name_en, b.name_cn, b.sku, b.category, b.unit, b.buy_unit, b.buy_pack_size,
           b.pack_contents_qty, b.pack_contents_unit,
           writtenCpu,
           b.buy_price, b.supplier,
           b.allergens, b.notes, b.accounting_category, b.item_kind, b.free_by_design,
           req.params.id);
    // Price history + the >5% alert, exactly as routes/ingredients.js does it.
    // Two edit doors onto one table must not disagree about whether a price
    // change is worth recording.
    if (b.buy_price && b.buy_price !== existing.buy_price) {
      tdb().prepare('INSERT INTO ingredient_price_history (ingredient_id,price,buy_unit,source,recorded_by) VALUES (?,?,?,?,?)')
        .run(req.params.id, b.buy_price, b.buy_unit, 'manual', (req.user && req.user.username) || 'backend');
      if (existing.buy_price > 0) {
        const pct = ((b.buy_price - existing.buy_price) / existing.buy_price) * 100;
        if (Math.abs(pct) >= 5) {
          tdb().prepare('INSERT INTO price_alerts (ingredient_id,old_price,new_price,change_pct) VALUES (?,?,?,?)')
            .run(req.params.id, existing.buy_price, b.buy_price, pct);
        }
      }
    }
    // Recompute trigger (§29 step 3). costFor() already pins a linked row's
    // cost to its existing value, so this can only be true for the kind of
    // write that actually feeds the rollup graph.
    const cpuMoved = !existing.source_recipe_id && Number(writtenCpu) !== Number(existing.cost_per_unit || 0);
    // tdb(), because fireRecompute WRITES through the handle it is given —
    // lib/recipe-rollup.js's applyRollup / applyProductCosts stamp
    // ingredients.cost_per_unit and store_products.unit_cost. Handing it the
    // global handle made the cascade rewrite Roots' costs from another
    // tenant's material edit, which is the widest of these writes.
    if (cpuMoved) fireRecompute(tdb(), { source: 'retail-materials.update', ingredient_id: Number(req.params.id) });
    res.json({ success: true });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(400).json({ success: false, ...skuClash(b.sku, req.params.id) });
    res.status(500).json({ success: false, error: 'save_failed', message: e.message });
  }
});

// ═══ Archive / restore ═════════════════════════════════════════════════════
// THE SKU IS KEPT (§18) — a reused code makes historical orders and reports
// point at the wrong thing. The kitchen half stopped nulling it; this door was
// never allowed to.
router.put('/api/retail-admin/materials/:id/archive', requireRetailAdmin, (req, res) => {
  const row = tdb().prepare('SELECT id FROM ingredients WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  const active = req.body && req.body.restore ? 1 : 0;
  tdb().prepare('UPDATE ingredients SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(active, req.params.id);
  res.json({ success: true, is_active: active });
});

module.exports = router;
