'use strict';

// Comparing a channel's listing name to the name we stored for it — the ONE
// place that rule lives, for Meituan and Eleme both.
//
// WHY THIS IS A LIB AND NOT A FUNCTION IN EACH ROUTE
// --------------------------------------------------
// `normName` existed twice, byte for byte, in routes/meituan-internal.js and
// routes/eleme-internal.js — the second file says in its own header that it is a
// deliberate copy of the first. So did the bug below, and so would the fix have,
// in whichever copy someone remembered. lib/meituan-map-write.js's header states
// the house rule this follows: a rule stated in two places is a rule that will be
// true in one of them.
//
// WHAT WENT WRONG, 2026-09-21, Meituan order MT20260921488622
// -----------------------------------------------------------
// A customer bought the 230g peach yogurt. The 130g came off the shelf.
//
// Tianhe maps the two sizes to two listings whose names differ ONLY inside the
// brackets:
//
//   product 265 (1-190, Big)   → 纯素椰子酸奶-桃子味Peach (230g)
//   product 264 (1-180, Small) → 纯素椰子酸奶-桃子味Peach(130g)
//
// The old normaliser deleted every bracketed run before comparing, because
// brackets are where a 货号 ("(1-300)") and a storage note ("(冷藏)") live and
// neither belongs in a name. But the SIZE lives there too. Both names collapsed
// to `纯素椰子酸奶桃子味peach`, identical — and the caller then took the FIRST row
// the database handed back, with no check that a second one had matched just as
// well. A coin flip, landing on the wrong bottle, deducting the wrong stock, and
// pushing the wrong count back to the channel. Nothing anywhere said a word.
//
// TWO FIXES, BOTH NEEDED
// ----------------------
//   1. `normListingName` KEEPS a size and drops the rest of the bracket. 230g and
//      130g are now different names, which is what they always were.
//   2. `pickByListingName` REFUSES a tie instead of taking the first row. Sizes
//      are one way two listings can read alike; they are not the only way, and the
//      next one will not be caught by (1). A refusal surfaces the line as
//      unresolved, where an operator sees it. A guess does not.
//
// (2) is the one that matters in a year. The old code already demanded a unique
// candidate on its substring fallback and then skipped that demand on the exact
// path above it — the strict branch was the loose one.

// A size inside a bracket: a number, then a weight or volume unit.
//
// The trailing lookahead is what keeps "(2 large)" from reading as two litres —
// a unit followed by more letters is a word, not a unit. CJK units need no such
// guard and must not have one, or "190克)" would be refused for its bracket.
const SIZE_RX = /(\d+(?:\.\d+)?)\s*(kg|g|克|公斤|ml|毫升|l|升)(?![A-Za-z])/gi;

// One size, in one unit per dimension, so a listing written 230克 and a mapping
// written 230g are the same size rather than two.
function canonSize(qty, unit) {
  const n = parseFloat(qty);
  if (!(n > 0)) return '';
  const u = String(unit).toLowerCase();
  if (u === 'kg' || u === '公斤') return `${n * 1000}g`;
  if (u === 'g'  || u === '克')   return `${n}g`;
  if (u === 'l'  || u === '升')   return `${n * 1000}ml`;
  return `${n}ml`;                       // ml / 毫升
}

// The sizes in one bracketed run, or a space when it holds none.
//
// A 货号 does not survive this and is not meant to: "(1-300)" has no unit after
// its digits, so it matches nothing and the whole run goes, exactly as before.
function sizesIn(run) {
  const out = [];
  for (const m of String(run).matchAll(SIZE_RX)) {
    const s = canonSize(m[1], m[2]);
    if (s) out.push(s);
  }
  return out.length ? ` ${out.join(' ')} ` : ' ';
}

// Collapse a listing name for comparison: keep the letters, the digits and any
// SIZE; drop spacing, punctuation, case and everything else in brackets. So
// "巧克力榛棒 Premium Nutella Bars" still equals its map entry across the CN/EN
// word order and Meituan's stray spacing, and "…Peach (230g)" no longer equals
// "…Peach(130g)".
//
// HALF-WIDTH BRACKETS ONLY, deliberately unchanged from the original. A
// full-width （…） run is not stripped here — its contents survive the way they
// always have, because they are as often part of the name (（大）, （小）) as a
// note about it. Widening that is a separate judgement about live mappings, not
// a size fix.
function normListingName(s) {
  return String(s || '')
    .replace(/\([^)]*\)/g, sizesIn)      // (1-300) → gone · (230g) → 230g
    .replace(/[\s　]+/g, '')             // all spaces incl. full-width
    .replace(/[^\p{L}\p{N}]/gu, '')      // punctuation/symbols
    .toLowerCase();
}

// Find THE row this line's name belongs to, or refuse.
//
//   { hit: row }            — exactly one row is this name
//   { hit: null, ambiguous: true }  — two or more were, so we are not guessing
//   { hit: null, ambiguous: false } — none were; the caller's later branches run
//
// `nameOf` reads the stored channel name off a row, so the two channels' column
// names (meituan_name / eleme_name) stay in their own files.
//
// Exact first, then substring — Meituan and Eleme both append and trim suffixes
// on an order line, so a name that is contained in the other is still worth
// taking. Both steps demand exactly one survivor. The substring step runs only
// when nothing matched exactly, so a listing whose name is a prefix of another's
// cannot steal a line that named its neighbour outright.
function pickByListingName(rows, nameOf, wanted) {
  const none = { hit: null, ambiguous: false };
  if (!wanted || !Array.isArray(rows) || !rows.length) return none;

  const exact = rows.filter(r => normListingName(nameOf(r)) === wanted);
  if (exact.length === 1) return { hit: exact[0], ambiguous: false };
  if (exact.length > 1)   return { hit: null, ambiguous: true };

  const cands = rows.filter(r => {
    const mn = normListingName(nameOf(r));
    return mn && (mn.includes(wanted) || wanted.includes(mn));
  });
  if (cands.length === 1) return { hit: cands[0], ambiguous: false };
  return { hit: null, ambiguous: cands.length > 1 };
}

module.exports = { normListingName, pickByListingName };
