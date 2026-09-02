// Finance category text — the ONE normalisation.
//
// WHY THIS EXISTS
// ---------------
// `ingredients.accounting_category`, `po_line_items.expense_category` and
// `expense_entries.category` hold the same vocabulary as free text, and Finance
// groups by that text. Two strings that read identically on screen but differ by
// one byte are two categories in every report.
//
// Measured on the live database 2026-08-24, before this module existed:
//
//   Ingredients(Kitchen+Retail Use) 原材料（厨房及零售通用）      273 + 85 + 16 rows
//   Ingredients (Kitchen + Retail Use) 原材料（厨房及零售通⽤）    62 + 12 +  9 rows
//
// The second is not a different category. It differs in exactly two ways:
//   * ASCII spacing in the English half — `Ingredients (Kitchen + Retail Use)`
//     against `Ingredients(Kitchen+Retail Use)`;
//   * ONE character in the Chinese half — U+2F64 ⽤ KANGXI RADICAL USE where the
//     first has U+7528 用 CJK UNIFIED IDEOGRAPH. They are different code points
//     that render near-identically in almost every font, which is why this was
//     read as a display quirk for months rather than as two rows in a report.
//
// A Kangxi radical is a character from the block Unicode reserves for showing
// radicals in dictionaries. It has no business in running text and arrives by
// paste — from a spreadsheet, a PDF, or an input method offering the radical
// above the ideograph. Nobody types one on purpose.
//
// WHAT THIS NORMALISES, AND WHAT IT DELIBERATELY DOES NOT
// -------------------------------------------------------
// NFKC over the whole string would fix the radical AND destroy the label: it
// rewrites （ ） to ( ) and would turn every Chinese parenthesis in this
// vocabulary into an ASCII one, changing 31 master-list values that are correct
// today. So NFKC is applied PER CHARACTER, and only to the two radical blocks:
//
//   U+2E80–U+2EFF  CJK Radicals Supplement
//   U+2F00–U+2FDF  Kangxi Radicals
//
// Every other character is passed through untouched. Fullwidth punctuation is
// correct Chinese typography here and is left exactly as it is.
//
// ASCII whitespace is trimmed and internal runs collapse to one space. CJK text
// has no spaces to collapse, so this only ever touches the English half.
//
// NOT NORMALISED — case, and translation. `fresh veggie 蔬菜` is not folded onto
// `Vegetables 蔬菜`, and `dried fruits 果干` is not folded onto `Dried Fruits 果干`.
// Those differ in their ENGLISH WORDS, not in their bytes, and deciding they are
// the same category is a judgement about the business, not a repair of a paste.
// This module repairs bytes. See scripts/normalise_finance_categories.js, which
// lists them as REVIEW rather than touching them.
//
// WHERE IT IS APPLIED: at the point of STORAGE, in every writer of the three
// columns, not at one input boundary. There is no single boundary — the columns
// are written from the ingredient form, the ingredient bulk edit, the ingredient
// CSV import, the kitchen PO, the kitchen order submit, the retail PO, and both
// back-order paths. A boundary check would be one more thing a new route can be
// written without. `normaliseCategory` sits next to the INSERT instead.

'use strict';

// The two blocks whose characters are radicals-as-text and always a paste
// artefact. Both NFKC-decompose to the unified ideograph they depict.
const RADICAL_BLOCKS = [
  [0x2e80, 0x2eff],   // CJK Radicals Supplement
  [0x2f00, 0x2fdf],   // Kangxi Radicals
];

function isRadicalBlock(cp) {
  for (const [lo, hi] of RADICAL_BLOCKS) if (cp >= lo && cp <= hi) return true;
  return false;
}

/**
 * Normalise one finance-category string for storage.
 *
 * Returns null for null/undefined and for anything that trims to empty, so a
 * blank field stores as NULL rather than as '' — the columns already treat
 * those two the same and every reader COALESCEs one to the other.
 *
 * Idempotent: normalise(normalise(x)) === normalise(x). The backfill script
 * depends on that to be safely re-runnable.
 */
function normaliseCategory(value) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  let out = '';
  for (const ch of s) {                       // iterate by code point, not code unit
    const cp = ch.codePointAt(0);
    out += isRadicalBlock(cp) ? ch.normalize('NFKC') : ch;
  }
  out = out.replace(/[ \t\r\n\f\v]+/g, ' ').trim();
  return out === '' ? null : out;
}

/** True when storing `value` would change it — used by the dry-run report. */
function needsNormalising(value) {
  if (value === null || value === undefined) return false;
  return String(value) !== (normaliseCategory(value) ?? '');
}

// ── The spacing half of the defect ─────────────────────────────────────────
//
// `normaliseCategory` alone does NOT collapse the two live families, and that
// is deliberate. Measured:
//
//   Ingredients(Kitchen+Retail Use) …     canonical, in the picker's master list
//   Ingredients (Kitchen + Retail Use) …  variant: radical AND spaces around ( and +
//
// The radical is a byte artefact and this module repairs it. The spaces are not
// — `Maintenance&Repairs` and `Maintenance & Repairs` are equally plausible
// spellings and stripping ASCII spaces from every label would be a guess about
// typography, not a repair. So spacing is not normalised; it is RESOLVED, and
// only against the vocabulary the tenant already keeps.
//
// `spacingKey` is a comparison key, never stored: normalised, ASCII spaces
// removed, case-folded. Two strings sharing a key differ only in ways that
// cannot mean two different categories.
function spacingKey(value) {
  const n = normaliseCategory(value);
  if (n === null) return null;
  return n.replace(/ /g, '').toLowerCase();
}

/**
 * What to STORE for a finance category: normalised, then snapped to the
 * tenant's own master list (`categories` for `kind`) when one of its entries
 * differs only by spacing or case.
 *
 * The master list is the authority because it is what the picker offers, and it
 * is CLEAN — measured 2026-08-24, zero of its 31 rows carry a radical. Every
 * bad value in the data arrived from somewhere that is not the picker: a CSV
 * import, or a paste into a free-text field.
 *
 * Snapping only ever moves a value ONTO a value the tenant already has. It
 * never invents one, and a category with no master entry (`销货成本`,
 * `门店进货 Retail stock`) is stored normalised and otherwise untouched.
 *
 * `dbHandle` is any better-sqlite3-shaped handle. A failure to read the master
 * list is not fatal — the value still stores normalised, which is the half that
 * matters for the defect this fixes.
 *
 * `kind` NAMES WHICH LIST TO SNAP AGAINST, and defaults to 'accounting' — the
 * money-OUT list, which is every caller that existed before 2026-09-02 and whose
 * behaviour is unchanged by this parameter. Money IN passes 'income', the kind
 * added to `routes/lookups.js` for §36's *Income categories move server-side*.
 *
 * **THE TWO LISTS MUST NOT BE CROSSED.** Snapping an income value against the
 * expense list would move it onto a name the tenant keeps for a different
 * purpose — silently, and reading as a match on every screen afterwards. The
 * kind is therefore a parameter rather than a widened query: `WHERE kind IN
 * ('accounting','income')` would snap in both directions at once and is exactly
 * the collision this argument exists to prevent.
 */
function storeCategory(dbHandle, value, kind = 'accounting') {
  const n = normaliseCategory(value);
  if (n === null) return null;
  try {
    const key = spacingKey(n);
    const rows = dbHandle.prepare('SELECT name FROM categories WHERE kind = ?').all(kind);
    for (const r of rows) if (spacingKey(r.name) === key) return r.name;
  } catch (e) {
    // No categories table yet, or a read error. Normalised is still correct.
  }
  return n;
}

module.exports = { normaliseCategory, needsNormalising, spacingKey, storeCategory, RADICAL_BLOCKS };
