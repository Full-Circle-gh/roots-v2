// Recipe cost breakdown — the ONE derivation, shared by the server and the
// browser the same way lib/ingredient-cost.js is.
//
// WRAPPED IN AN IIFE so `const API` (and everything else declared at top
// level below) is a closure-local binding, not a page-global one. Node's
// CommonJS wrapper already isolates the file for `require()`, but the browser
// loads this exact file via a plain <script src="/lib/recipe-cost.js"> tag
// (see the loader note further down), and a bare top-level `const`/`let` in a
// classic script IS a global lexical binding shared with every other <script>
// on the page — including a browser extension's content script, which is
// exactly what generic names like `API` collide with in the wild. That
// collision is a SyntaxError ("Identifier 'API' has already been declared"),
// thrown at parse time, which aborts this entire file before a single line
// runs — so `window.RootsRecipeCost` never gets set, every reader of it
// silently falls back to the recipe's last-saved server figures, and the
// Recipes editor's live cost totals look frozen until the next Save. The fix
// is scoping, not renaming: nothing outside this file ever refers to `API` by
// name, only via `module.exports` / `window.RootsRecipeCost`.
(function () {
// WHY THIS EXISTS
// ---------------
// `recipe_cost_data` stores only the MANUAL inputs — labour, packaging,
// overhead_pct, sell_price, target_food_cost. It holds no cost column of any
// kind. Every actual cost figure (ingredient subtotal, batch cost, per serving,
// per gram, margin, food cost %) is derived on read, and that derivation used
// to exist in five separate copies:
//
//   lib/recipe-cost.js  computeRecipeCost()      this file, export route only
//   public/app.html     viewRecipe()             ~:6483  recipe detail card
//   public/app.html     showCostSheet/renderCS   ~:7660  Cost Sheet, first paint
//   public/app.html     csUpdate()               ~:7970  Cost Sheet, live retype
//   public/app.html     _loadProductCtx()        ~:9653  product card — DEAD, its
//                                                result was never read by any
//                                                renderer
//
// Four of those are now gone: viewRecipe(), renderCS() and csUpdate() call this
// file over HTTP, and the export route requires it. routes/waste.js's
// computeProductCost() was the fifth and is now folded on too — it reads
// costPerServing straight off this breakdown, honours free_by_design like every
// other reader, and has no sell-price fallback. It kept its own packaging-free
// batch total for a while (packaging is reused when a finished unit is wasted);
// Step 4 below took packaging out of batchCost for everyone, so that private
// subtraction had become a duplicate formula and was removed.
//
// One reader remained outside it:
//
//   * _loadProductCtx()'s dead block, removed rather than ported — see above.
//
// ONE DERIVATION, TWO FIGURES
// ---------------------------
// Since 2026-08-26 this file answers two different questions about the same
// batch: what a SERVING costs to sell (costPerServing, costPerGram, batchCost)
// and what a GRAM costs another recipe that consumes it (materialCostPerGram).
// They differ by packaging, and the difference is declared once in
// MATERIAL_COST_COMPONENTS below rather than subtracted at the call site.
//
// THE FORMULA IS COPIED, NOT REDESIGNED
// -------------------------------------
// Every line below mirrors what renderCS() computed before it was swapped onto
// this file, including its quirks. Two are worth naming so a later reader does
// not "fix" them and silently move a number on a screen Roots reads daily:
//
//   * `parseFloat(cd.target_food_cost || 30)` — a STORED target of 0 becomes
//     30, because `0 || 30` is 30. Preserved deliberately.
//   * An ingredient line whose master cost is 0 or null contributes NOTHING to
//     the subtotal and is counted as a missing cost instead. It is not treated
//     as a genuine zero.
//
// A CALLER MUST HAND THIS FILE NUMBERS, NOT DOM STRINGS
// -----------------------------------------------------
// The `|| 30` quirk above is why. A costData carrying the STRING '0' takes a
// different branch from the NUMBER 0: `'0' || 30` is `'0'` (a non-empty string
// is truthy) and parses to 0, while `0 || 30` is 30. csUpdate() reads live form
// inputs, which are always strings, so it coerces each field with its own
// `parseFloat(...)||fallback` at the DOM boundary and passes the resulting
// numbers in. Hand a raw `input.value` to this function and a zeroed target
// food cost will silently mean something different here than it does on the
// stored row.
//
// NO WRITES, NO DB REQUIRED. The id-form takes a database handle; the
// rows-form is pure. Either way this module only ever reads.

'use strict';

// ── §7 addendum: no conversion without a stated factor ──────────────────────
//
// A line's cost is `qty × costPerUnit`, where qty is in the LINE's unit and
// costPerUnit is per the MATERIAL's stocking unit. That multiplication is only
// meaningful when the two units measure the same kind of thing. Nothing used to
// check, so 160 ml of an oil stocked in grams was costed as 160 g — a confident
// number, wrong by whatever the oil's density is.
//
// The dimensions, and NOT a conversion table. There is deliberately no ml→g
// factor here: volume to weight needs a density, density is a property of the
// material rather than of the system, and §7's addendum forbids inventing one.
// The only thing this decides is whether the two units are comparable at all.
const UNIT_DIMENSION = {
  // mass
  g: 'mass', kg: 'mass', lb: 'mass', oz: 'mass',
  // volume
  ml: 'volume', l: 'volume', liter: 'volume', litre: 'volume',
  // Spoon and cup measures. Coverage of the table, NOT a change to the rule
  // below: these are real volume units carried by live recipe lines. While
  // they were absent, unitDimension() returned null for them and the escape in
  // unitsReconcilable() read that as reconcilable, so a line in tsp against a
  // material stocked in g costed its volume as mass with nothing on screen.
  // Nothing is STOCKED in a spoon unit — stocking units in live use are only
  // 'g' and 'pcs' (checked 2026-08-27) — so adding these cannot flip any
  // material's dimension; they can only change how a LINE is read.
  tsp: 'volume', tbsp: 'volume', cup: 'volume',
  teaspoon: 'volume', teaspoons: 'volume',
  tablespoon: 'volume', tablespoons: 'volume', cups: 'volume',
  // whole things counted out
  pcs: 'count', bag: 'count', bottle: 'count', box: 'count',
  can: 'count', jar: 'count', case: 'count', pack: 'count', tub: 'count',
};

function unitDimension(unit) {
  return UNIT_DIMENSION[String(unit == null ? '' : unit).trim().toLowerCase()] || null;
}

// Can this line's quantity be priced with this material's cost at all?
//
// ONLY a KNOWN mismatch blocks. A unit this table does not recognise — a blank,
// or something an old import wrote — has no dimension to disagree with, so it
// keeps whatever behaviour it has today. Widening the block to "not recognised"
// would be a different decision about different rows, and it is not this one.
//
// A recorded density is what will make a volume↔mass pair reconcilable. That
// field does not exist yet (it belongs on the material, not here), which is why
// this reads as a bare dimension comparison: today there is never a density to
// find, so "the dimensions differ" and "differ with no density recorded" are
// the same condition. When the field lands, it is consulted here.
function unitsReconcilable(lineUnit, stockUnit) {
  const a = unitDimension(lineUnit);
  const b = unitDimension(stockUnit);
  if (a === null || b === null) return true;
  return a === b;
}

// ── WHAT A BATCH WEIGHS, AND HOW MANY SERVINGS COME OUT OF IT ───────────────
//
// `recipes.batch_size` is grams (schema.sql) and it was typed by hand. Nobody
// typed it: 105 live recipes, and the ones that matter most — the ones backing
// a material — are exactly the ones where a missing batch size stops the whole
// cost cascade (lib/recipe-rollup.js's `no_batch_size`). A batch size is not a
// judgement in the ordinary case; it is the sum of what went into the pot, and
// a person adding it up on a calculator is a person making arithmetic mistakes
// in the one number every downstream cost divides by.
//
// So it is derived, and the two facts that make deriving it honest are recorded
// per line and per recipe rather than assumed:
//
//   NOT EVERYTHING THAT GOES IN COMES OUT. A vegetable stock brewed for its
//   flavour and then poured away is a real ingredient with a real cost and NO
//   share of the yield. That is `recipe_ingredients.in_yield` — a per-line
//   fact a human states, defaulting to 1, because "did this end up in the
//   product" is not something the system can infer from a name.
//
//   A RECIPE MAY STILL SAY ITS OWN YIELD. Reduction, evaporation, trim loss and
//   a bag that is filled to a stated weight are all cases where the sum of the
//   inputs is not what comes out, and the operator's own figure is the true
//   one. That is `recipes.batch_size_auto` — 0 means "the stored number stands,
//   leave it alone".
//
// THE SUM IS REFUSED RATHER THAN UNDERSTATED. Grams are only added to grams.
// A line counted in ml or in pcs cannot be weighed without a density or a
// piece weight, neither of which exists (the same §7 addendum reasoning that
// keeps unitsReconcilable from inventing an ml→g factor), so ONE such line
// blocks the whole derivation and the recipe keeps whatever batch size it has.
// A batch size that is short by one ingredient is far worse than none: it is
// divided into batchCost to make costPerGram, which becomes a material's unit
// cost, which becomes a product's cost and its margin — a silent overstatement
// all the way down. Absent, the cascade refuses out loud and always has.
//
// Mass units convert among themselves with EXACT, STATED factors, which is the
// condition §7's addendum sets. Nothing here converts across a dimension.
const MASS_TO_G = Object.freeze({
  g: 1, gram: 1, grams: 1,
  kg: 1000, kilo: 1000, kilos: 1000, kilogram: 1000, kilograms: 1000,
  lb: 453.59237, lbs: 453.59237, pound: 453.59237, pounds: 453.59237,
  oz: 28.349523125, ounce: 28.349523125, ounces: 28.349523125,
});

// Float noise has no place in a figure an operator reads back and re-types.
// 15 + 4.5 + 3.75 must be 23.25, not 23.250000000000004, and four decimals is
// well past anything a kitchen scale resolves.
// `|| 0` on the way out as well as in: Math.round(-1e-17 * 1e4) is NEGATIVE
// ZERO, which is a perfectly ordinary result of `batchSize - servings *
// servingSize` on a batch that divides exactly, and which String()s to "-0".
// A remainder of minus nothing is not a sentence anyone should read.
function round4(n) { return (Math.round((Number(n) || 0) * 1e4) / 1e4) || 0; }

// This quantity in grams, or null when the unit is not a mass at all.
function massInGrams(qty, unit) {
  const f = MASS_TO_G[String(unit == null ? '' : unit).trim().toLowerCase()];
  if (!f) return null;
  const q = parseFloat(qty);
  return Number.isFinite(q) ? q * f : null;
}

// The stored flags are 0/1 INTEGER columns, but they arrive from a JSON body as
// booleans and from a form as strings. ABSENT IS MANUAL, deliberately: a caller
// that hands this file a hand-built recipe object (a diagnostic, an old script,
// a partial row) predates the column, and it must keep the behaviour it has
// always had — the stored number, untouched.
function isAuto(v) { return v === 1 || v === true || v === '1'; }

// A line counts toward the yield unless somebody said it does not. Default-on
// for the same reason: every line written before the column existed did end up
// in the product, and a default of "excluded" would silently empty every batch.
function lineInYield(line) {
  return !(line && (line.in_yield === 0 || line.in_yield === false || line.in_yield === '0'));
}

/**
 * What the ingredient lines add up to, in grams.
 *
 * Returns `grams: null` and `ok: false` when the sum would be a lie — a line
 * that cannot be weighed, or nothing left to weigh at all — and names the
 * lines responsible so a screen can point at them instead of reporting a
 * condition nobody can act on.
 */
function computeYield(ingredients) {
  let grams = 0;
  let countedLines = 0;
  let excludedLines = 0;
  const blockingLines = [];
  (ingredients || []).forEach((i, index) => {
    if (!lineInYield(i)) { excludedLines++; return; }
    const g = massInGrams(i.qty, i.unit);
    if (g === null) {
      blockingLines.push({ index, name: i.name_en || i.master_name_en || '', unit: i.unit || '' });
      return;
    }
    grams += g;
    countedLines++;
  });
  const ok = blockingLines.length === 0 && countedLines > 0;
  return {
    grams: ok ? round4(grams) : null,
    countedLines,
    excludedLines,
    blockingLines,
    ok,
    // Why not, in one word, for a caller that has to say so.
    reason: ok ? null : (blockingLines.length ? 'unweighable_lines' : 'no_countable_lines'),
  };
}

/**
 * The batch size and serving count this recipe actually has right now —
 * derived where the recipe says derive, stored where it says stored.
 *
 * THE ONE PLACE either question is answered. computeRecipeCost calls it, the
 * write path calls it to stamp the columns (lib/recipe-yield.js), and the
 * Recipes editor calls it on every keystroke. A second copy of "batch ÷ serving
 * size" is how a field and a cost start disagreeing about the same recipe.
 *
 * SERVINGS ARE FLOORED. 224.55 g at 25 g a serving is eight servings and 24.55 g
 * left in the pot — it is not 8.98 of anything sellable. Flooring also errs the
 * safe way: the remainder stays inside costPerServing rather than being costed
 * as if it walked out of the door.
 */
function resolveYield(recipe, ingredients) {
  const r = recipe || {};
  const batchAuto = isAuto(r.batch_size_auto);
  const y = batchAuto ? computeYield(ingredients) : null;
  const storedBatch = parseFloat(r.batch_size) || 0;
  const batchSize = (y && y.ok) ? y.grams : storedBatch;

  const servingsAuto = isAuto(r.servings_auto);
  const servingSize = parseFloat(r.serving_size) || 0;
  const storedServings = parseFloat(r.servings) || 0;
  let servings = storedServings;
  let servingsLeftover = null;
  if (servingsAuto) {
    if (batchSize > 0 && servingSize > 0) {
      // toFixed(6) before the floor: 300/25 is 12, but 0.3/0.1 is 2.9999…, and
      // a batch that divides exactly must never come out one serving short.
      servings = Math.floor(Number((batchSize / servingSize).toFixed(6)));
      servingsLeftover = round4(batchSize - servings * servingSize);
    } else {
      servings = 0;
    }
  }
  return {
    batchSize, servings, servingSize,
    batchAuto, servingsAuto, servingsLeftover,
    yield: y,
  };
}

// One ingredient line's contribution. Mirrors app.html:7511-7516 — a line whose
// master cost is not > 0 yields a null lineCost and is counted as missing,
// rather than adding 0 to the subtotal. A line whose unit cannot be reconciled
// with its material's stocking unit takes the SAME path — null, excluded from
// the subtotal, counted — but on its own counter, because the two are different
// facts: one material has no cost, the other has a perfectly good cost that
// this line's quantity cannot be multiplied by.
function buildLines(ingredients) {
  let ingredientCost = 0;
  let zeroCostLines = 0;
  let unreconciledUnitLines = 0;
  // How much of the subtotal above is overhead a CHILD recipe already added.
  // Counted so the parent can leave it out of its own overhead base — see
  // computeRecipeCost. Zero for every bought material, and zero today for
  // every made one too, since only one live recipe carries an overhead rate
  // and it backs no material.
  let embeddedOverhead = 0;
  const lines = (ingredients || []).map((i) => {
    const costPerUnit = i.master_cost || 0;
    const qty = parseFloat(i.qty) || 0;
    // An item marked free by design costs a real zero. It adds nothing to the
    // subtotal and — the point of the flag — is NOT counted as a missing cost,
    // so water in 26 recipes stops crying wolf over the one that matters.
    const isFree = !!i.master_free;
    // Free by design is decided by a human and outranks the unit question: a
    // line that costs nothing costs nothing in any unit.
    const unreconciled = !isFree && !unitsReconcilable(i.unit, i.master_unit);
    const lineCost = isFree
      ? 0
      : (unreconciled || !(costPerUnit > 0) ? null : qty * costPerUnit);
    if (lineCost === null) {
      // Counted once, on the counter that describes it. An unreconciled line is
      // not a missing cost and must not be reported as one.
      if (unreconciled) unreconciledUnitLines++;
      else zeroCostLines++;
    } else {
      ingredientCost += lineCost;
      // Only a priced, reconciled, non-free line contributes — the same three
      // conditions that let it into the subtotal. A line excluded from the
      // subtotal must not carry overhead into a base derived from it.
      if (!isFree) embeddedOverhead += qty * (Number(i.master_overhead_per_unit) || 0);
    }
    return {
      ingredient_id: i.ingredient_id == null ? null : i.ingredient_id,
      name: i.name_en || i.master_name_en || '',
      name_cn: i.name_cn || null,
      sku: i.sku || null,
      qty,
      unit: i.unit || '',
      masterUnit: i.master_unit || '',
      costPerUnit,
      lineCost,
      freeByDesign: isFree,
      unreconciledUnit: unreconciled,
    };
  });
  return { lines, ingredientCost, zeroCostLines, unreconciledUnitLines, embeddedOverhead };
}

// The three statements the id-form uses. Kept identical to the ones
// GET /api/recipes/:id already runs (routes/recipes.js:57-61) so the export
// cannot diverge from what the Cost Sheet is fed.
const SQL_RECIPE = 'SELECT * FROM recipes WHERE id = ?';
const SQL_INGREDIENTS = `SELECT ri.*, i.cost_per_unit AS master_cost, i.unit AS master_unit,
         i.free_by_design AS master_free,
         i.overhead_per_unit AS master_overhead_per_unit,
         i.name_en AS master_name_en
    FROM recipe_ingredients ri
    LEFT JOIN ingredients i ON ri.ingredient_id = i.id
   WHERE ri.recipe_id = ?
   ORDER BY ri.sort_order`;
const SQL_COST = 'SELECT * FROM recipe_cost_data WHERE recipe_id = ?';

/**
 * Full cost breakdown for one recipe.
 *
 * Two call shapes:
 *   computeRecipeCost(42, db)
 *       loads the recipe, its ingredient lines and its cost row through `db`
 *       (which MUST be a seamed handle — see lib/db-seam.js).
 *
 *   computeRecipeCost({ recipe, ingredients, costData })
 *       uses rows the caller already has. This is what the export uses: it
 *       reads all 85 recipes in three queries instead of 255.
 *
 * `costData` may be null/undefined — a recipe with no `recipe_cost_data` row.
 * In that case labour, packaging, overhead_pct and sell_price are all treated
 * as 0, target_food_cost falls back to its schema default of 30, and
 * `hasCostRow` on the result is false.
 *
 * Returns null only when an id was given and no such recipe exists.
 */

// ── §29: WHICH OF A RECIPE'S COSTS TRAVEL WITH ITS OUTPUT ───────────────────
//
// A recipe's output can leave in two different ways, and they do not cost the
// same thing:
//
//   SOLD    — a serving goes out in a retail container the business bought.
//             That container is part of what the sellable unit costs.
//   CONSUMED— the rest of the batch is held in bulk and later ladled into
//             another recipe. It goes into a reused kitchen tub. Nobody buys a
//             retail container for it, and no cost is tracked for the tub.
//
// §29 made a made thing a material and left this open. The rule: A COST DERIVED
// FROM MAKING A THING IS NOT AUTOMATICALLY A COST OF USING IT. Only the costs
// incurred in producing the quantity consumed travel with it; costs incurred in
// SELLING it do not, and must not reach a parent that never incurs them.
//
// THIS TABLE IS THE ONE ANSWER, AND IT IS DELIBERATELY A TABLE. The obvious
// version of this fix is `batchCost - packagingTotal` at the one call site in
// lib/recipe-rollup.js. That works today and is a trap: the next cost to come
// under question is overhead, and it would land as a second subtraction in a
// second place with its own arithmetic, and then "which costs travel" would
// have two answers that drift. Written this way, changing the answer is editing
// one boolean — not adding a mechanism.
//
// WHY EACH FLAG IS WHERE IT IS:
//
//   ingredients — obviously travel. They ARE the material.
//   labour      — TRAVELS. Work on a bulk batch was genuinely performed, and
//                 the parent is consuming its product. Whoever made the sauce
//                 was paid whether it was sold or ladled.
//   overhead    — TRAVELS, provisionally. Same argument as labour, and settled
//                 the same way for now. ⚠️ IT IS NOT THE SAME QUESTION: overhead
//                 is a PERCENTAGE OF INGREDIENT COST, so when a parent applies
//                 its own overhead to a line that already carries the child's,
//                 it COMPOUNDS rather than duplicates. That is a different fault
//                 from this one and it is NOT settled here. Nothing exercises it
//                 today — see below — which is why it can wait for its own
//                 answer instead of being guessed at now.
//   packaging   — DOES NOT TRAVEL. This is the change. See
//                 docs/packaging-findings.md finding 1 for what it cost: eleven
//                 materials carrying a phantom share, worst at 38% of the
//                 material's own unit cost, reaching store_products.unit_cost
//                 and the margin column.
//
// NOT IN LIVE USE TODAY, AND THAT IS THE POINT OF SETTLING IT NOW: exactly one
// recipe carries labour or overhead and it backs no material, so both flags are
// inert. Deciding them while they cost nothing is cheaper than deciding them
// under a wrong number later.
const MATERIAL_COST_COMPONENTS = Object.freeze({
  ingredients: true,
  labour:      true,
  overhead:    true,
  packaging:   false,
});

function computeRecipeCost(input, db) {
  let recipe;
  let ingredients;
  let costData;

  if (input !== null && typeof input === 'object') {
    recipe = input.recipe;
    ingredients = input.ingredients || [];
    costData = input.costData;
  } else {
    if (!db || typeof db.prepare !== 'function') {
      throw new Error('[recipe-cost] a database handle is required when called with a recipe id');
    }
    recipe = db.prepare(SQL_RECIPE).get(input);
    if (!recipe) return null;
    ingredients = db.prepare(SQL_INGREDIENTS).all(recipe.id);
    costData = db.prepare(SQL_COST).get(recipe.id);
  }
  if (!recipe) return null;

  const hasCostRow = !!costData;
  const cd = costData || {};

  const { lines, ingredientCost, zeroCostLines, unreconciledUnitLines, embeddedOverhead } = buildLines(ingredients);

  // ── renderCS() app.html:7522-7533, line for line ────────────────────────
  const labour = parseFloat(cd.labour || 0);
  const packaging = parseFloat(cd.packaging || 0);
  const overheadPct = parseFloat(cd.overhead_pct || 0);
  const sellPrice = parseFloat(cd.sell_price || 0);

  // ── THE BATCH, RESOLVED BEFORE ANYTHING IS DIVIDED BY IT ────────────────
  // Not `recipe.batch_size` and `recipe.servings` read straight off the row any
  // more: a recipe may derive either one (see resolveYield above), and every
  // figure below divides by them. Resolving here rather than at each call site
  // is what makes the derived batch size reach the material rollup, the Excel
  // export, the waste screen and the Cost Sheet without any of them knowing the
  // feature exists. A recipe with both flags off — every recipe that already
  // carried a typed batch size — resolves to exactly the two numbers this line
  // used to read.
  const y = resolveYield(recipe, ingredients);
  const servings = y.servings;

  // Packaging is a PER SERVING figure. With no servings recorded it is counted
  // once rather than dropped — the `servings>0?servings:1` in the original.
  const packagingTotal = packaging * (servings > 0 ? servings : 1);
  // ── OVERHEAD DOES NOT COMPOUND (§29's second addendum, settled 2026-08-27)
  //
  // The base is the FOOD cost of this recipe's lines, with any overhead a
  // child recipe already added taken out of it. The child's overhead is still
  // in ingredientCost and still in this batch's total — it simply stops being
  // something this recipe's percentage multiplies a second time.
  //
  // WHY, in Ash's words: overhead is an estimate, not a measured input. Real
  // depth is three levels, so compounding multiplies the guess three times and
  // nobody can trace the result back to anything. It is also §29's own shape —
  // the cost of MAKING the sauce is not a second cost of USING it.
  //
  // §29's second addendum flagged this as the open question overhead left
  // behind and said it was cheap to settle while nothing exercised it. Nothing
  // does: one live recipe carries a rate (Hummus Asli, 1%) and it backs no
  // material, so embeddedOverhead is 0 everywhere and this changes no figure
  // today. That is the point of doing it now rather than under a wrong number
  // later.
  //
  // The base cannot go negative: embeddedOverhead only ever accumulates from
  // lines that made it into ingredientCost, and a material's overhead share
  // cannot exceed its own cost. Clamped anyway — a negative rate applied to a
  // negative base would come out positive, which is the kind of arithmetic
  // nobody would ever spot on screen.
  const overheadBase = Math.max(0, ingredientCost - embeddedOverhead);
  const overheadAmount = overheadBase * overheadPct / 100;
  // ── STEP 4: PACKAGING IS NOT PART OF WHAT A RECIPE COSTS ────────────────
  //
  // §31: "THE RECIPE CARRIES NO PACKAGING." A recipe is what it costs to make
  // the FOOD. The container is a cost of the sellable unit, and since the
  // build list shipped it is recorded there — as real lines, at real
  // purchase prices, one per thing.
  //
  // packagingTotal is still COMPUTED and still RETURNED, deliberately: 93 of
  // 105 live cost rows carry a figure, screens need to be able to say what
  // was recorded there, and a migration that cannot show the old number is a
  // migration nobody can check. It is simply no longer part of any total.
  //
  // WHAT THIS MOVES, STATED PLAINLY BECAUSE IT MOVES REAL MARGINS: every
  // product still taking its cost from a recipe (67 of 76 at the time of
  // writing) loses its packaging contribution here and does not get it back
  // until that product has a build list of its own. Their costs drop and
  // their margins read high in the gap. Accepted by Ash 2026-08-27 as the
  // price of build-then-strip — the alternative order leaves no cost source
  // at all — and the number was put in front of him before he agreed to it.
  //
  // Worked example, recipe 64: batch 736.79 -> 718.87, per serving
  // 46.05 -> 44.93. That 44.93 is EXACTLY what the build line already
  // charges for 220 g of the material this recipe makes, which is the proof
  // the two were one figure counted twice.
  const batchCost = ingredientCost + labour + overheadAmount;

  const costPerServing = servings > 0 ? batchCost / servings : null;
  const batchSize = y.batchSize;
  const costPerGram = batchSize > 0 ? batchCost / batchSize : null;

  // The SAME batch, costed for the other way out (§29, table above). Kept
  // beside costPerGram rather than replacing it: costPerGram is what this batch
  // actually cost per gram and several screens show it as exactly that. This is
  // a narrower figure with one consumer — the material rollup — and conflating
  // them would put a number on screen that is true of nothing.
  const M = MATERIAL_COST_COMPONENTS;
  // Since Step 4 removed packaging from batchCost, and M.packaging is false,
  // this now evaluates to the same number batchCost does. The table STAYS —
  // it is the written answer to "which of a recipe's costs travel with the
  // material" (§29's second addendum) and the next cost to come under
  // question changes one boolean here rather than adding a subtraction
  // somewhere new. Two names for one figure today is cheap; rediscovering
  // the rule from arithmetic is not.
  const materialBatchCost =
      (M.ingredients ? ingredientCost : 0)
    + (M.labour      ? labour         : 0)
    + (M.overhead    ? overheadAmount : 0)
    + (M.packaging   ? packagingTotal : 0);
  // Null on the same condition as costPerGram, so the rollup's existing
  // "no_cost_per_unit" gate keeps refusing exactly the recipes it refused
  // before — a recipe with no batch size, and nothing else.
  const materialCostPerGram = batchSize > 0 ? materialBatchCost / batchSize : null;

  const marginPerServing = sellPrice > 0 && costPerServing !== null ? sellPrice - costPerServing : null;
  const foodCostPct = sellPrice > 0 && costPerServing !== null ? costPerServing / sellPrice * 100 : null;

  const targetFoodCost = parseFloat(cd.target_food_cost || 30);
  const suggestedSellPrice = costPerServing !== null && targetFoodCost > 0
    ? costPerServing / (targetFoodCost / 100)
    : null;

  return {
    recipe_id: recipe.id,
    hasCostRow,
    costDataUpdatedAt: cd.updated_at || null,

    // Recipe identity, so a caller holding only this object can label a row.
    sku: recipe.sku || null,
    name_en: recipe.name_en || '',
    name_cn: recipe.name_cn || null,
    category: recipe.category || null,
    servings,
    batchSize,
    // How those two were arrived at, so a screen can say "auto" rather than
    // printing a number with no account of where it came from, and so a
    // diagnostic can tell a derived batch size from a typed one.
    batchSizeAuto: y.batchAuto,
    servingsAuto: y.servingsAuto,
    // What the batch does NOT divide into whole servings — the tail end left in
    // the pot. Null when servings are typed rather than derived.
    servingsLeftover: y.servingsLeftover,
    // The ingredient-line sum behind an auto batch size, and why it was refused
    // when it was: `{ grams, countedLines, excludedLines, blockingLines, ok,
    // reason }`, or null on a recipe that states its own batch size.
    yield: y.yield,

    // Ingredients
    ingredientCost,
    ingredientLines: lines.length,
    zeroCostIngredientLines: zeroCostLines,
    // Lines whose own unit measures a different kind of thing than their
    // material's stocking unit, so the quantity cannot be priced at all. NOT a
    // missing cost — see buildLines.
    unreconciledUnitLines,
    lines,

    // Stored inputs
    labour,
    packaging,
    packagingTotal,
    overheadPct,
    overheadAmount,
    // Exposed so a screen or a diagnostic can show WHY a base differs from the
    // ingredient subtotal, rather than leaving the gap to be rediscovered.
    embeddedOverhead,
    overheadBase,
    sellPrice,
    targetFoodCost,

    // Derived — the SALE path. Untouched by §29's material rule.
    batchCost,
    costPerServing,
    costPerGram,

    // Derived — the MATERIAL path. What a gram of this costs another recipe
    // that consumes it. Read by lib/recipe-rollup.js and by nothing else.
    materialBatchCost,
    materialCostPerGram,
    marginPerServing,
    foodCostPct,
    suggestedSellPrice,
  };
}

// MATERIAL_COST_COMPONENTS is exported so the answer to "which costs travel"
// can be read and asserted by diagnostics rather than inferred from arithmetic.
//
// buildLines is exported for lib/product-build-cost.js (Step 2 of
// docs/tacet-product-build-lines-design.md). Its actual signature — an array
// of {ingredient_id, qty, unit, master_cost, master_unit, master_free,
// name_en, sku} objects, nothing about recipe_id/servings/batch_size inside
// it — was already recipe-agnostic (design doc §2); this just stops hiding
// that fact. A product build list is a flat sum of build lines with no
// servings/batch-size division, so it calls this directly rather than going
// through computeRecipeCost, which stays recipe-schema-bound on purpose.
//
// unitsReconcilable is exported for the two SCREENS that now say out loud what
// this file has always done silently. Neither re-derives the rule:
//
//   * routes/retail.js's products list asks it once per (line unit, stocking
//     unit) pair for the recipes behind the page's rows, so the Products grid
//     can mark a cost that is short some ingredients. Costing each recipe
//     properly would be three queries a row; this is one query for the page.
//   * public/retail-admin/19-recipes.js reads it off `lines[].unreconciledUnit`
//     from computeRecipeCost, which is the same call it already makes — the
//     export is what lets the LIST route ask the identical question without
//     paying for a full breakdown.
//
// A second copy of "do these two units measure the same kind of thing" is
// exactly how a warning and a total end up disagreeing about one line.
const API = { computeRecipeCost, MATERIAL_COST_COMPONENTS, buildLines, unitsReconcilable, unitDimension,
  // The yield half, exported for the same reason the cost half is: the
  // Recipes editor derives a batch size live on every keystroke, the write
  // path stamps the same figure onto the row, and neither may hold its own
  // copy of the arithmetic.
  computeYield, resolveYield, massInGrams, lineInYield, MASS_TO_G };

// Two loaders, one file — the same contract lib/ingredient-cost.js keeps. Node
// requires it (the Excel export route, diagnostics). The recipe detail card and
// the Cost Sheet fetch it from /lib/recipe-cost.js and read it off window —
// served with no-store, and skipped by the service worker, because a phone
// running yesterday's money formula against today's server is the failure this
// arrangement exists to prevent. No bundler, and deliberately no second copy:
// four hand-maintained copies of this maths is what let a product card compute
// a cost nobody could see and a waste figure ignore a flag every other screen
// honoured.
if (typeof module !== 'undefined' && module.exports) module.exports = API;
// globalThis rather than a bare `window`, so the file stays valid Node source
// (and lints as such) while still publishing itself in a browser.
if (typeof globalThis !== 'undefined' && globalThis.window) globalThis.window.RootsRecipeCost = API;
})();
