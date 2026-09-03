// Who may read what a product COSTS — `products:costs` (Ash, 2026-09-03).
//
// `products:view` opens the catalogue; `products:costs` reads the cost and the
// margin on it. They were one capability marked money:'shows', and it is held
// by FIVE presets — including `staff`, whose own comment in lib/capabilities.js
// says "no money-sensitive powers", and `marketing`, "no operations/money".
// Both read a margin percentage on every row of the products grid.
//
// SELL PRICE IS NOT WHAT MOVES. What a customer is charged is on the storefront
// and stays for anyone who may open the catalogue. What goes is `unit_cost` —
// what we pay — and the margin derived from it.
//
// WHY THIS IS A MODULE and its two siblings are not. routes/retail-waste.js and
// routes/retail-materials.js keep the same three functions inline, because each
// is a small file a test can mount on a bare express app and drive. routes/
// retail.js is ~32,000 lines with the whole product surface in it and cannot be
// stood up that way — so the rules live here, where scripts/
// test_product_cost_visibility.js can call them directly and hold them to the
// same contract as the other two. The route requires this; nothing else should
// re-implement it.
//
// THE THREE RULES, identical to waste and materials on purpose:
//   • FAILS CLOSED. Every other capability check in this product answers
//     "unknown ⇒ allow", because an operator locked out of their own app by a
//     resolution hiccup is worse than one shown a control they cannot use.
//     Money inverts that trade: a figure missing for one render is
//     recoverable, a figure shown to somebody who may not read one is not.
//     public/retail-admin/01-core.js states the rule beside its own can():
//     "do NOT gate anything that leaks money/PII on caps alone without a
//     reliable fallback." This is that fallback.
//   • KEYS ARE DELETED, NOT ZEROED. A cost of 0 reads as free and reports a
//     100% margin — the exact bug the write path already guards against.
//   • IT REFUSES A FIELD, NEVER A REQUEST. Nobody is 403'd for lacking this;
//     the catalogue answers in full, minus two columns.

'use strict';

function canSeeProductCosts(req) {
  return !!(req && req.caps && typeof req.caps.has === 'function' && req.caps.has('products:costs'));
}

// `cost_incomplete` travels WITH unit_cost and never apart from it — the tag is
// a statement about that exact figure (routes/retail.js's VERSION_COLUMNS says
// the same where it explains why a restore moves the two together), so a
// payload carrying the tag without the cost describes a number that is not
// there.
function stripProductCost(row) {
  if (!row || typeof row !== 'object') return row;
  delete row.unit_cost;
  delete row.cost_incomplete;
  return row;
}

// One call site for a row or an array of them, so a read cannot be half-gated.
function stripProductCosts(req, rows) {
  if (canSeeProductCosts(req)) return rows;
  if (Array.isArray(rows)) { rows.forEach(stripProductCost); return rows; }
  return stripProductCost(rows);
}

// The write half. Every branch that writes unit_cost in routes/retail.js is
// guarded by `'unit_cost' in body`, so deleting the keys means "not touched"
// through the contract that already exists rather than a new one.
//
// This is data loss, not just a permission: the editor hides the Cost field, its
// g() helper returns '' for a missing element, and '' is parsed to NULL on the
// way in — so editing a product's NAME would have wiped its cost, blanked the
// margin everywhere it is read, and cleared the cost_incomplete tag with it.
function stripProductCostWrites(req, body) {
  if (!body || canSeeProductCosts(req)) return body;
  delete body.unit_cost;
  delete body.cost_incomplete;
  return body;
}

module.exports = { canSeeProductCosts, stripProductCost, stripProductCosts, stripProductCostWrites };
