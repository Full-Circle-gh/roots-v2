// Kitchen app (public/app.html, routes/ingredients.js and friends) still
// shares roots.db with Tacet, the live retail system. Tacet now owns material
// cost (ingredients.cost_per_unit / buy_price), recipe lines
// (recipe_ingredients / product_build_lines) and recipe cost data
// (recipe_cost_data, and a recipe's own cost-bearing fields) — a kitchen-app
// write to any of those silently corrupts what Tacet shows, since staff no
// longer use the kitchen app and have no reason to expect their edit to move
// a number someone else is reading. This module is the route-layer refusal:
// every write path that touches one of those three categories rejects with a
// clear 403 instead of writing. READ paths are untouched, so the app still
// loads and shows correct figures — this only stops it from writing new
// wrong ones. Nothing here touches the database itself.
//
// See docs/tacet-... (kitchen-app-cost-fixes) for the route inventory this
// backs — every call site is commented with which of the three categories it
// was blocking.

function respond(res, label) {
  res.status(403).json({
    success: false,
    error: 'kitchen_cost_write_blocked',
    message: `This kitchen app action is disabled: ${label} is now owned by Tacet and can no longer be edited here. `
            + `· 此厨房端操作已停用:${label}现由 Tacet 系统管理,无法在此编辑。`,
  });
}

// Unconditional refusal — this route always touches one of the three
// categories when it succeeds, so it is blocked outright.
function blockCostWrite(label) {
  return (req, res) => respond(res, label);
}

// Conditional refusal — this route only sometimes touches one of the three
// categories (it depends on the request body, e.g. a status flip), so a
// request that would not trigger the write passes through untouched.
function blockCostWriteIf(predicate, label) {
  return (req, res, next) => {
    if (predicate(req)) return respond(res, label);
    next();
  };
}

module.exports = { blockCostWrite, blockCostWriteIf };
