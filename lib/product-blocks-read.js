// Reading the office's product blocks for a surface that is NOT the mini app.
//
// WHAT description_blocks IS. An array the office authors in the product
// editor, each entry a typed block with its own bespoke visual on the mini
// app's product page — a hero paragraph, three numbered claims, a chip cloud of
// ingredients, an allergen card, usage tiles. miniapp/components/product-blocks
// renders all eleven types. This file reads the TWO a counter menu needs, and
// deliberately understands nothing else.
//
// WHY IT IS HERE AND NOT IN THE PAGE. The QR menu is the second reader of these
// blocks, exactly as it became the second reader of the nutrition column. The
// mini app's component is a WeChat bundle and cannot be required from Node, so
// the shapes below are a SECOND implementation of one contract, and
// scripts/test_product_blocks_read.js reads that component's source to hold the
// two together — the type names, the field names and the labels.
//
// THE ALLERGEN CARD IS THE POINT OF THIS FILE. It separates CONTAINS from MAY
// CONTAIN TRACES OF, which is the distinction a person with an allergy actually
// needs and which nothing else on a product can reconstruct. free_of — the
// filter tags behind the storefront's GLUTEN FREE chips — cannot: an absent tag
// there means "not tagged", never "contains". An earlier draft of the counter
// menu derived allergens from free_of by negation and would have told a
// customer a product contained something nobody had said it did.

'use strict';

// Both the mini app's separators: an ASCII comma and the two CJK ones. A list
// typed in Chinese is split the same way as one typed in English.
function splitChips(s) {
  return String(s == null ? '' : s)
    .split(/[,、，]/g)
    .map(x => x.trim())
    .filter(Boolean);
}

function blocksOf(raw) {
  let b = raw;
  if (typeof b === 'string') {
    if (!b.trim()) return [];
    try { b = JSON.parse(b); } catch { return []; }
  }
  return Array.isArray(b) ? b : [];
}

// The ingredients, from whichever of the two blocks the office used.
// -> { items: [{ name_en, name_cn, pct, lead }] } or null.
//
// BOTH TYPES CARRY THE SAME ITEMS and differ only in how the mini app draws
// them — a chip cloud or an editorial line. A reader that understood only one
// would go blank for half the catalogue for a purely visual reason.
function ingredientsOf(raw) {
  for (const b of blocksOf(raw)) {
    const t = b && b.type;
    if (t !== 'ingredients_chips' && t !== 'ingredients_line') continue;
    const items = (Array.isArray(b.items) ? b.items : [])
      .map(it => ({
        name_en: String((it && it.name_en) || '').trim(),
        name_cn: String((it && it.name_cn) || '').trim(),
        // A percentage the office chose to state. Absent is normal.
        pct: (it && it.pct != null && it.pct !== '' && Number.isFinite(Number(it.pct)))
          ? Number(it.pct) : null,
        // The hero ingredient — the filled pill on the mini app's cloud.
        lead: !!(it && it.lead),
      }))
      .filter(it => it.name_en || it.name_cn);
    if (items.length) return { items };
  }
  return null;
}

// The allergen card. -> { contains_en, contains_cn, may_en, may_cn } as arrays,
// or null when the office declared neither.
//
// EACH LANGUAGE IS SPLIT SEPARATELY rather than picked here, because this page
// ships both and lets CSS choose. A product whose Chinese list is filled and
// whose English one is not returns an empty English array, and the caller draws
// the row it has — it does not fall back across languages, which would put
// Chinese text inside an English label.
function allergensOf(raw) {
  for (const b of blocksOf(raw)) {
    if (!b || b.type !== 'allergen_card') continue;
    const out = {
      contains_en: splitChips(b.contains_en),
      contains_cn: splitChips(b.contains_cn),
      may_en: splitChips(b.may_contain_en),
      may_cn: splitChips(b.may_contain_cn),
    };
    if (out.contains_en.length || out.contains_cn.length ||
        out.may_en.length || out.may_cn.length) return out;
  }
  return null;
}

// The labels, copied from miniapp/components/product-blocks/product-blocks.js.
// Not composed: the mini app already says these words to this tenant's
// customers, and a second wording for one idea is the defect §30 exists for.
const LABELS = {
  ingredients: { en: 'Ingredients', cn: '配料表' },
  allergens:   { en: 'Allergens',   cn: '过敏原' },
  contains:    { en: 'Contains',    cn: '含有' },
  mayContain:  { en: 'May contain traces of', cn: '可能含有微量' },
  none:        { en: 'None declared', cn: '未声明' },
};

// The product's own words, in the order the office wrote them.
// -> [{ type, kicker_en, kicker_cn, body_en, body_cn }], possibly empty.
//
// ADDED FOR §129, WHICH REVERSED §120 ON THIS EXACT POINT. §120 read the two
// safety blocks and recorded that the counter surface was "deliberately NOT the
// marketing paragraph": a person standing at a counter is deciding whether they
// can eat it. Ash reversed that on 2026-09-15 reading his own menu — "i cant see
// the description" — and a read of the live database settled that the text was
// there rather than missing: all seven listed products carry a hero_intro, 250
// across the catalogue.
//
// TWO TYPES, AND EACH KEEPS ITS OWN FIELD NAME. This is the whole subtlety of
// the file. The mini app does NOT use one shape for prose:
//
//   hero_intro     body_en / body_cn   + an optional kicker_en / kicker_cn
//   notes_callout  text_en / text_cn
//
// A reader that looked for body_* on both would return the paragraph and
// silently drop every notes_callout — 231 of them in this catalogue, carrying
// the line about stirring before use and the one about a supplement not
// treating anything. That is exactly the failure §120 made with the hero, one
// level down, and it is invisible: the block is there, the read comes back
// empty, and nothing says so. The first draft of this function did it.
//
// THE OTHER PROSE-LOOKING TYPES ARE DELIBERATELY ABSENT. `why` is a list of
// claims (rows[].claim_en, or a legacy rows_en array), `how_to_use` is tiles,
// `storage_box` is two cards, `big_stat` is a figure and a caption. None is a
// paragraph, each needs its own visual, and a reader that named them here
// without reading their shapes would return nothing for them forever while
// looking like it had them covered. When one of those is wanted, it gets its
// own reader and its own rendering — not a line added to this list.
const PROSE_TYPES = ['hero_intro', 'notes_callout'];

function proseOf(raw) {
  const out = [];
  for (const b of blocksOf(raw)) {
    const t = b && b.type;
    if (PROSE_TYPES.indexOf(t) < 0) continue;
    // hero_intro says body_*, notes_callout says text_*. Both halves are
    // carried and neither language is chosen here: bi() on the page switches.
    const pick = (a, c) => String(a != null ? a : (c != null ? c : '')).trim();
    const body_en = t === 'notes_callout' ? pick(b.text_en) : pick(b.body_en);
    const body_cn = t === 'notes_callout' ? pick(b.text_cn) : pick(b.body_cn);
    if (!body_en && !body_cn) continue;
    out.push({
      type: t,
      kicker_en: pick(b.kicker_en),
      kicker_cn: pick(b.kicker_cn),
      body_en,
      body_cn,
    });
  }
  return out;
}

module.exports = { ingredientsOf, allergensOf, proseOf, splitChips, blocksOf, PROSE_TYPES, LABELS };
