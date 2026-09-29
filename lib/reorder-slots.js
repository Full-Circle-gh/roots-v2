'use strict';

// The sort_order values to hand back out when a set of products is dragged
// into a new order (POST /api/retail-admin/products/reorder).
//
// The set keeps its own slots — read its current values, sort them, and give
// them out in the new sequence — so only the order WITHIN the set changes and
// arranging one shelf never shuffles another. A set that was never sorted (all
// slots equal) gets a fresh 1..n ramp.
//
// SLOTS MUST COME OUT DISTINCT. A new product lands on sort_order 0, so a shelf
// is often part-sorted: [0, 0, 3]. Handing back two equal slots left the pair
// tied, the shop broke the tie by name, and the drag appeared not to stick.
// Each slot is therefore lifted to one above the one before it when it would
// tie or fall behind; the first slot, and so the set's place among everything
// else, stays where it was.
function reorderSlots(current, n) {
  let slots = current.map(v => Number(v) || 0).sort((a, b) => a - b);
  if (!slots.length) return [];
  if (slots[0] === slots[slots.length - 1]) return Array.from({ length: n }, (_, i) => i + 1);
  for (let i = 1; i < slots.length; i++) {
    if (slots[i] <= slots[i - 1]) slots[i] = slots[i - 1] + 1;
  }
  return slots;
}

module.exports = { reorderSlots };
