'use strict';
// ── The forty products whose cost IS complete ────────────────────────────────
//
// Ash's instruction, 2026-09-14: mark "this cost is not complete"
// (store_products.cost_incomplete = 1) on EVERY product except the SKUs below.
//
// WHY A LIST OF KEEPERS RATHER THAN A LIST OF TARGETS. The instruction was
// given as an exception list, and an exception list is the shorter, checkable
// half: forty lines a person can read against their own catalogue versus
// several hundred they cannot. Inverting it here — expanding it into the set to
// tick — would make the committed artefact something nobody can compare to what
// was actually asked for.
//
// ONE SOURCE FOR THE SURVEY AND THE WRITE. scripts/diagnose_cost_incomplete_sweep.js
// reads this list to say what a run would do; scripts/oneoff_mark_cost_incomplete.js
// reads the same list to do it. A dry run that surveyed a different list than
// the apply writes is not a dry run, and two copies of forty strings is exactly
// how that happens. It lives in lib/ because that is what .github/workflows/
// ro-query.yml and oneoff.yml stage onto the box; scripts/ is not staged, so a
// module beside the scripts could not be required by either.
//
// VERBATIM, INCLUDING THE SPACE IN "1-310 D". The list is stored exactly as it
// was given. Matching is done on a normalised key (see skuKey) so a stored
// "1-310D" still matches, but the record of what was asked for is not rewritten
// to suit what the database happens to hold.
const KEEP_SKUS = [
  '1-20', '1-30', '1-40', '1-70', '1-80', '1-90', '1-100', '1-110', '1-120',
  '1-220', '1-310', '1-310 D', '1-320', '1-320 D', '1-360', '1-370', '1-380',
  '1-400', '1-410', '1-420', '1-430', '1-440', '1-460',
  '2-140', '2-170', '2-180',
  '3-20', '3-70', '3-140', '3-210', '3-230', '3-240', '3-251',
  '4-240', '4-360', '4-640', '4-650', '4-670', '4-680', '4-690',
];

// The comparison key. Case-folded and stripped of ALL whitespace, so
// "1-310 D", "1-310d" and "1-310 d" are one product and not three.
//
// IT DOES NOT UNWRAP `S(...)`. docs/tacet-channel-line-resolution-findings.md
// records rows whose sku reads `S(3-251)` — a SEPARATE single-unit row beside
// the pack, not another spelling of it. Folding the two together here would
// silently extend a forty-product exception to rows Ash did not name. Any such
// row is reported by the survey as a near miss, for a person to rule on.
function skuKey(sku) {
  return sku == null ? null : String(sku).replace(/\s+/g, '').toUpperCase();
}

const KEEP_KEYS = new Set(KEEP_SKUS.map(skuKey));

// True when this row is one Ash named — i.e. it must NOT be marked.
function isKeeper(sku) {
  const k = skuKey(sku);
  return k != null && KEEP_KEYS.has(k);
}

module.exports = { KEEP_SKUS, KEEP_KEYS, skuKey, isKeeper };
