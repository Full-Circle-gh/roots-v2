// Nested-recipe cycle guard (§29). A material can be `source_recipe_id`-linked
// to the recipe that makes it; that recipe's own ingredient lines can in turn
// consume other linked materials — a dependency graph, not just a tree. This
// is the repo's first graph/cycle structure. There is no precedent to mirror:
// the one existing candidate ("bundles refuse to nest") turned out to be
// structural — meituan_bundle_components only has a product_id column, no
// self-reference — not a runtime check, so it left nothing to copy here.
//
// Every function below takes a `db`-shaped handle (anything supporting
// .prepare(sql).all()/.get(), better-sqlite3 or a seamed wrapper) so the same
// code runs against production and against an in-memory fixture identically —
// see scripts/test_recipe_graph_cycles.js, which builds synthetic graphs this
// way rather than testing against a mocked graph shape that could drift from
// the real one.
//
// NO WRITES. Read-only queries only.

'use strict';

// One edge per (recipe, linked-material-it-consumes) pair: recipe_id R has an
// edge to recipe_id S when R's own recipe_ingredients lines include an
// ingredient whose source_recipe_id is S — "R depends on what S makes".
// A direct self-line (an ingredient whose source_recipe_id equals the very
// recipe consuming it) is excluded here and handled by the caller as the
// trivial self-reference case, not as a one-node loop in this graph.
//
// Rebuilt on every call. The whole graph is bounded by how many materials are
// linked at all (27 today) — there is nothing worth caching at this size, and
// caching a graph that changes underneath it is a second bug waiting to
// happen for a first bug this file exists to prevent.
function buildDependencyEdges(db) {
  const rows = db.prepare(`
    SELECT DISTINCT ri.recipe_id AS from_recipe, i.source_recipe_id AS to_recipe
      FROM recipe_ingredients ri
      JOIN ingredients i ON i.id = ri.ingredient_id
     WHERE i.source_recipe_id IS NOT NULL
  `).all();
  const edges = new Map(); // recipe_id -> Set<recipe_id>
  for (const r of rows) {
    if (r.from_recipe === r.to_recipe) continue; // trivial self-line, not this graph's concern
    if (!edges.has(r.from_recipe)) edges.set(r.from_recipe, new Set());
    edges.get(r.from_recipe).add(r.to_recipe);
  }
  return edges;
}

// Breadth-first: is `toId` reachable from `fromId` by following edges?
// fromId === toId returns [fromId] — a recipe trivially reaches itself, which
// is how checkCycle() gets the direct self-reference case (a recipe consuming
// the material it makes) for free rather than special-casing it.
// The `seen` set is what makes this terminate on a graph that ALREADY holds a
// cycle — a real possibility since this reads live data, and the shape a naive
// walk spins on forever.
// Returns the path (both ends inclusive) or null.
function findPath(edges, fromId, toId) {
  if (fromId === toId) return [fromId];
  const queue = [[fromId]];
  const seen = new Set([fromId]);
  while (queue.length) {
    const path = queue.shift();
    const last = path[path.length - 1];
    for (const next of (edges.get(last) || [])) {
      if (next === toId) return [...path, next];
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}

// Would adding `ingredientId` as a line inside `recipeId`'s own ingredient
// list create a cycle?
//
// Only a source_recipe_id-linked material can carry an edge back into the
// graph at all — an ordinary purchased ingredient is a leaf, never a risk —
// so this returns { ok: true } immediately for anything unlinked.
//
// Adding the line is equivalent to adding an edge recipeId -> sourceRecipeId.
// That closes a cycle exactly when sourceRecipeId can ALREADY reach recipeId
// through existing edges (sourceRecipeId -> ... -> recipeId): the new edge
// would complete the loop back to where it started.
//
// Returns { ok: true } or { ok: false, chain: [recipeId, ...] } where chain
// is the existing dependency path from the material's source recipe back to
// recipeId — the thing that would close the loop — for the caller to name in
// its refusal rather than erroring generically.
function checkCycle(db, { recipeId, ingredientId }) {
  const ing = db.prepare('SELECT id, source_recipe_id FROM ingredients WHERE id = ?').get(ingredientId);
  if (!ing || !ing.source_recipe_id) return { ok: true };
  const sourceRecipeId = ing.source_recipe_id;
  const edges = buildDependencyEdges(db);
  const path = findPath(edges, sourceRecipeId, recipeId);
  if (!path) return { ok: true };
  return { ok: false, chain: path };
}

// Would LINKING `materialId` to `recipeId` (§29 step 5's materialize action —
// setting ingredients.source_recipe_id = recipeId on an EXISTING, previously
// unlinked material) create a cycle?
//
// The mirror image of checkCycle() above. That function asks "would ADDING A
// LINE that consumes materialId create a cycle", by checking whether
// materialId's (already-set) source recipe can reach recipeId. This one asks
// "would materialId itself BECOMING recipeId's output create a cycle" — and
// the risk runs the other direction. materialId may already be consumed as an
// ingredient line by any number of OTHER recipes; linking it to recipeId is
// equivalent to adding an edge from EVERY one of those consumers to recipeId
// at once (each would now depend on recipeId to get materialId). A cycle
// closes if recipeId can already reach any one of those consumers through its
// OWN existing dependency graph — including recipeId itself, when recipeId
// already consumes materialId directly (the "needs its own output" case,
// covered here as a zero-length reach via findPath's fromId===toId rule).
//
// Returns { ok: true } or { ok: false, chain: [recipeId, ..., consumerId] } —
// the existing path from recipeId to the consumer that would close the loop.
function checkMaterializeCycle(db, { recipeId, materialId }) {
  const consumers = db.prepare(
    'SELECT DISTINCT recipe_id FROM recipe_ingredients WHERE ingredient_id = ?'
  ).all(materialId).map(r => r.recipe_id);
  if (!consumers.length) return { ok: true };
  const edges = buildDependencyEdges(db);
  for (const consumerId of consumers) {
    const path = findPath(edges, recipeId, consumerId);
    if (path) return { ok: false, chain: path };
  }
  return { ok: true };
}

module.exports = { buildDependencyEdges, findPath, checkCycle, checkMaterializeCycle };
