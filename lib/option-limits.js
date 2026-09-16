'use strict';

// How many answers a "Pick any" question takes — the one place that rule lives.
//
// A product option row (retail_product_options) of type 'multi' renders as a set
// of tick-boxes. Until min_choices/max_choices existed it took any number of
// them, including none. Those two columns bound it:
//
//   min_choices  at least this many must be ticked  (0 = no floor)
//   max_choices  at most this many may be ticked    (0 = no ceiling)
//
// "Choose 2 crunchy sides" is min 2 / max 2. Zero on both is the old unbounded
// behaviour, which is what every row written before this feature carries, so
// nothing that exists today changes shape.
//
// TWO CALLERS, ONE RULE. The save path (routes/retail.js saveProductOptions)
// normalises what the editor posts; the menu and the checkout (routes/shop-menu.js)
// clamp what the customer is shown and what they may submit. The browser clients
// deliberately get NO copy of this logic — they are handed the already-clamped
// numbers in the menu payload and obey them. A limit the client computes is a
// limit the client can compute differently.
//
// is_required is the older, coarser form of the same idea. For a multi question
// the two are kept in step on save: a floor of 1+ IS required, and Required with
// no floor means a floor of 1. Single-answer questions are untouched by any of
// this — a radio is exactly one answer by construction.

// Normalise what the editor posted into a storable pair. `count` is how many
// choices the group is being saved with, which is the ceiling a max can mean:
// "at most 5" on a three-choice group is just "no ceiling" written the long way.
// Returns { min_choices, max_choices, is_required } — required comes back
// because the floor and the flag are two faces of one rule and saving them out
// of step is how a group ends up required with a floor of 0.
function normaliseLimits(type, rawMin, rawMax, count, rawRequired) {
  const required = rawRequired ? 1 : 0;
  // Only 'multi' carries limits. A radio takes exactly one answer whether or not
  // it is required, and 'text' has no choices to count.
  if (type !== 'multi') return { min_choices: 0, max_choices: 0, is_required: required };

  const n = Math.max(0, Math.floor(Number(count) || 0));
  const int = (v) => {
    const i = Math.floor(Number(v));
    return Number.isFinite(i) && i > 0 ? i : 0;
  };
  let min = int(rawMin);
  let max = int(rawMax);

  // A floor or ceiling past the number of choices cannot be met or cannot bind.
  if (min > n) min = n;
  if (max > n) max = 0;
  // An inverted pair is an editing slip, not an instruction. Honour the floor —
  // it is the half a customer is blocked by — and drop the ceiling.
  if (max && min > max) max = min;
  // Required and the floor say the same thing; whichever was set wins.
  if (required && !min) min = 1;
  return { min_choices: min, max_choices: max, is_required: (min > 0 ? 1 : required) };
}

// What the limits ACTUALLY are once sold-out choices are taken off the group.
//
// THE FLOOR IS NOT ABSOLUTE. "Choose 2 crunchy sides" with two of the three sold
// out cannot be answered, and an unanswerable required question does not make a
// product unbuyable here — it stops being a floor. Same principle the menu
// already renders by: a question with no answers left is not asked at all.
// `live` is the number of choices still pickable (not sold out).
//
// The ceiling needs no clamping — a max of 2 on one live choice simply never
// binds — but it is returned alongside so callers have one shape to read.
function effectiveLimits(opt, live) {
  const n = Math.max(0, Math.floor(Number(live) || 0));
  if (!opt || opt.type !== 'multi') return { min: 0, max: 0 };
  const min = Math.min(Math.max(0, Math.floor(Number(opt.min_choices) || 0)), n);
  const max = Math.max(0, Math.floor(Number(opt.max_choices) || 0));
  return { min, max: max > n ? 0 : max };
}

module.exports = { normaliseLimits, effectiveLimits };
