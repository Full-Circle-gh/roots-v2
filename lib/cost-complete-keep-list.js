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

// ── Do the keepers' OTHER PACK SIZES count as keepers? ───────────────────────
//
// THE DECISION THIS CONSTANT HOLDS. Ash's forty were read off the products
// page, where a variant family folds into ONE row. The database does not: a
// pack of five pitas is `3-251` and a single pita is `S(3-251)`, two rows. So
// forty names can cover more than forty rows, and this says whether they do.
//
// TRUE MEANS THE PAGE MATCHES THE LIST HE GAVE. Verified against production
// on 2026-09-14 (ro-query run 34906561863): six of the forty share a
// variant_group_id with a row a sweep would mark —
//
//   1-220 ← S(1-220)      3-210 ← (3-210) X 3, (3-210) X5
//   1-30  ← S(1-30）      3-251 ← S(3-251)
//   4-240 ← S(4-240)      4-360 ← S(4-360)
//
// — and _paCostIncomplete() in public/retail-admin/09-products.js marks a
// folded cell IF ANY MEMBER IS TAGGED. With this false, those six keepers keep
// a clear tag of their own and their cell shows the mark regardless: the sweep
// would override six of the exclusions it was given, on the one screen they
// were given for. The eighth row, the （4-680）+（4-690） bundle, is in no
// variant group and is a presentation question rather than that one.
//
// SET TRUE. Ash's call, 2026-09-14, on that evidence: the single and the pack
// are the same goods, and "the cost of one pita is incomplete but the pack of
// five is fine" is not a claim anyone means to make.
//
// IT IS COMPUTED, NOT LISTED. The rows are found at run time — same variant
// group as a keeper, or a keeper's code inside the sku — so a pack added next
// month is covered without anyone remembering to add it here. A hardcoded list
// of eight would be right today and wrong at the next variant.
const KEEP_SIBLINGS = true;

// A keeper's code inside another row's sku: `S(3-251)`, `(3-210) X5`,
// `（4-680）+（4-690）`. Punctuation and case are already gone from the key, and
// the match is bounded on the right by a non-digit so `1-30` cannot match
// inside `1-300` — a real row, Quinoa Salad, which is NOT a keeper.
//
// `S(3-250)` and `S3-252` name 3-250 and 3-252, which nobody excluded, so they
// are marked like any other row. That falls out of the rule rather than needing
// a case.
function namesKeeper(sku) {
  const t = skuKey(sku);
  if (t == null) return false;
  return KEEP_SKUS.some(k => {
    const key = skuKey(k);
    if (t === key) return false;
    const i = t.indexOf(key);
    if (i < 0) return false;
    const after = t[i + key.length];
    return after === undefined || !/[0-9]/.test(after);
  });
}

// ── The two keepers whose cost Ash has answered COMPLETE ─────────────────────
//
// Both carry cost_incomplete = 1 from the 2026-08 seed, which ticked every
// product whose build list held contents and not one packaging line. Asked
// directly on 2026-09-14 what should happen to them, Ash answered: "1-90 and
// 1-370 price are complete."
//
// SO THEY ARE SET TO 0, NOT BACK TO NULL. database.js:5516-5531 spells out the
// three states and why the third is load-bearing: NULL is "nobody has
// answered", 0 is "answered: this cost holds everything it should". Ash has
// now answered. Writing NULL would throw that answer away and leave the pair
// looking like the two hundred products nobody has reached yet.
//
// ONLY THESE TWO. The other thirty-eight keepers are left exactly as they are.
// Ash excluded forty products from being marked and answered a question about
// these two; asserting "complete" for the other thirty-eight is a claim he did
// not make, and NULL versus 0 is precisely the difference between a product
// somebody has ruled on and one nobody has reached. Both render identically on
// the list today, so nothing is lost by leaving them unanswered.
const CLEAR_SKUS = ['1-90', '1-370'];
const CLEAR_KEYS = new Set(CLEAR_SKUS.map(skuKey));
function isCleared(sku) {
  const k = skuKey(sku);
  return k != null && CLEAR_KEYS.has(k);
}

module.exports = {
  KEEP_SKUS, KEEP_KEYS, KEEP_SIBLINGS, CLEAR_SKUS, skuKey, isKeeper, namesKeeper, isCleared,
};
