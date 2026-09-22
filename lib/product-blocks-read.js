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

/* ── §132 · EVERY BLOCK THE OFFICE WROTE, IN THE ORDER IT WROTE THEM ────────
   Ash, having seen the page draw only the paragraph: *"i want you to build the
   blocks of the product description same as the mini app."*

   THIS IS A SECOND IMPLEMENTATION OF THE MINI APP'S NORMALISER, AND IT DIFFERS
   FROM IT IN ONE STRUCTURAL WAY THAT GOVERNS THE WHOLE FILE. The component
   takes a language and calls `_pick(en, cn, L)` on every field, so it returns
   ONE language. This page ships BOTH and lets CSS choose — that is how every
   other string on the counter menu works — so nothing may be picked here. Every
   field comes back as a pair, and a block that carries only one language keeps
   the other empty rather than borrowing across, because bi() decides what a
   missing half does and this reader must not decide it first.

   ORDER IS THE OFFICE'S. The array is returned in the order the blocks sit on
   the product, not grouped by kind and not ranked here, so the page reads the
   way it was laid out in the editor.

   EMPTY BLOCKS ARE DROPPED, which is the component's own `_skip`. The editor
   leaves skeletons behind — the live read found `why`, `how_to_use` and
   `storage_box` present with nothing in them on most products — and a heading
   with nothing under it is the empty panel §120 refused to draw. */

/* NON-VEGAN EMOJI ARE SWAPPED, AND THIS MAP IS COPIED CHARACTER FOR CHARACTER
   FROM THE COMPONENT'S PB_ICON_FIX. It is not decoration: the office picks an
   icon from a general-purpose set and this is a plant-based brand, so a tile
   captioned "breakfast" can arrive carrying a rasher of bacon. Dropping this
   map while copying everything else around it would put meat on the menu of a
   shop that does not sell it. */
const ICON_FIX = {
  '\u{1F373}': '\u{1F958}', '\u{1F95A}': '\u{1F958}', '\u{1F9C0}': '\u{1F331}',
  '\u{1F9C8}': '\u{1F331}', '\u{1F953}': '\u{1F331}', '\u{1F356}': '\u{1F331}',
  '\u{1F357}': '\u{1F331}', '\u{1F969}': '\u{1F331}', '\u{1F354}': '\u{1F957}',
  '\u{1F32D}': '\u{1F957}', '\u{1F364}': '\u{1F957}', '\u{1F990}': '\u{1F957}',
  '\u{1F991}': '\u{1F957}', '\u{1F99E}': '\u{1F957}', '\u{1F980}': '\u{1F957}',
  '\u{1F41F}': '\u{1F957}', '\u{1F420}': '\u{1F957}', '\u{1F36F}': '\u{1F33F}',
  '\u{1F95B}': '\u{1F33F}', '\u{1F4E1}': '\u2668\uFE0F',
};
const icon = (v) => {
  const k = String(v == null ? '' : v).trim();
  return ICON_FIX[k] || k;
};

const txt = (v) => String(v == null ? '' : v).trim();
// A pair is kept when EITHER side has something. Both halves travel.
const pair = (en, cn) => ({ en: txt(en), cn: txt(cn) });
const has = (p2) => !!(p2.en || p2.cn);

// The heading each block wears, copied from the component. Nothing composed:
// every one of these is a string the mini app already shows this tenant's
// customers, so the same product reads the same words on both surfaces.
const HEADS = {
  why:         { en: 'Why people choose it', cn: '\u4e3a\u4ec0\u4e48\u9009\u5b83' },
  how_to_use:  { en: 'How to use',           cn: '\u7528\u6cd5' },
  storage_box: { en: 'Storage',              cn: '\u50a8\u5b58' },
  recipe:      { en: 'Method',               cn: '\u505a\u6cd5' },
  pairings:    { en: 'Goes well with',       cn: '\u642d\u914d\u63a8\u8350' },
  faq:         { en: 'Questions',            cn: '\u5e38\u89c1\u95ee\u9898' },
  nutrition:   { en: 'Nutrition',            cn: '\u8425\u517b\u6210\u5206' },
};
// The count line beside a heading. The component builds these by concatenation
// too ("6 moments", "6 \u79cd\u7528\u6cd5"), so the shape is its own, not invented.
const TAGS = {
  how_to_use: (n) => ({ en: n + ' moments', cn: n + ' \u79cd\u7528\u6cd5' }),
  recipe:     (n) => ({ en: n + ' steps',   cn: n + ' \u6b65' }),
  storage_box: { en: 'keep it right', cn: '\u4fdd\u9c9c\u65b9\u6cd5' },
};

// Nutrition rows classify by their English label, exactly as the component
// does, so a parent row is bold and a child row is indented on both surfaces.
const NUT_PARENT = ['energy', 'total fat', 'fat', 'carbohydrate', 'carbohydrates',
                    '\u80fd\u91cf', '\u8102\u80aa', '\u603b\u8102\u80aa', '\u78b3\u6c34\u5316\u5408\u7269'];
const NUT_CHILD = ['saturated', 'saturated fat', 'unsaturated', 'unsaturated fat', 'sugars',
                   '\u9971\u548c\u8102\u80aa', '\u4e0d\u9971\u548c\u8102\u80aa', '\u7cd6'];
const nutKind = (label) => {
  const k = txt(label).toLowerCase();
  if (NUT_PARENT.indexOf(k) >= 0) return 'parent';
  if (NUT_CHILD.indexOf(k) >= 0) return 'child';
  return 'normal';
};

/* A block the office has switched OFF for this page. One flag, one surface:
   `hide_qr` means "not on the counter menu". The mini app and the web
   storefront read the same array and ignore a field they don't know, which is
   what keeps a trim here from touching either of them.

   THE WORDS ARE NOT DELETED. Hiding is a rendering decision taken by the
   reader, not an edit to what the office wrote — the block travels intact and
   the same product still reads in full in the app.

   ── §229 · THREE STATES, BECAUSE A DEFAULT NEEDS SOMEWHERE TO ACT ─────────
   The flag used to be a boolean read as `!!b.hide_qr`, and under that reading
   there was nothing a catalogue-wide default could govern: absent already
   meant SHOWN, definitively, on every one of 287 products. Ash asked for the
   blocks Quinoa Salad shows to be the blocks every product shows, and the only
   way that rule can exist is for "nobody has said" to be distinguishable from
   "somebody said show it".

     hide_qr === true    hidden here. The office switched this block off.
     hide_qr === false   shown here. The office switched it ON against a
                         default that does not allow its type — the state that
                         could not be expressed before, and the reason a false
                         is now stored rather than deleted
                         (product-editor.html, paBlocksCollect).
     absent              ask `shownTypes`, the tenant's allow-list.

   IT IS AN ALLOW-LIST, NOT A BLOCK-LIST, and that distinction is the whole
   correction §229 records. A block-list — "these types are off" — says nothing
   about a type the reference product does not carry, so every such type keeps
   drawing and every type the editor gains next year arrives switched on. An
   allow-list answers for types nobody has thought about yet, which is what
   "show the same blocks" means.

   shownTypes ABSENT MEANS NO ALLOW-LIST IN FORCE — everything draws, exactly
   the pre-§229 behaviour. It does NOT mean the seed and it does NOT mean
   nothing. This file must not reach for a database: it is required by the mini
   app's test harness and by scripts that hold no tenant handle, so the list is
   always the caller's to supply. An EMPTY array is different again and is a
   real answer — allow nothing. lib/qr-menu-block-defaults.js is where a real
   list comes from and routes/shop-menu.js is the one production caller. */
function hiddenHere(b, shownTypes) {
  if (!b) return false;
  if (b.hide_qr === true) return true;
  if (b.hide_qr === false) return false;
  if (!Array.isArray(shownTypes)) return false;   // no list in force
  return shownTypes.indexOf(b.type) < 0;
}

// Did the office write a nutrition block AT ALL, hidden or not? The counter
// menu falls back to the retail_products.nutrition column when no block says
// it, and that fallback must not resurrect a block the office just switched
// off — so the question is asked of the unfiltered source, never of the
// filtered list pageBlocks returns.
function hasNutritionBlock(raw) {
  return blocksOf(raw).some(b => b && b.type === 'nutrition_facts');
}

function pageBlocks(raw, shownTypes) {
  const out = [];
  for (const b of blocksOf(raw)) {
    const t = b && b.type;
    if (!t) continue;
    if (hiddenHere(b, shownTypes)) continue;

    if (t === 'spec_strip') {
      const src = Array.isArray(b.cells) ? b.cells
        : [b.cell1, b.cell2, b.cell3].filter(Boolean);
      const cells = src.map(c => ({ k: pair(c && c.k_en, c && c.k_cn), v: pair(c && c.v_en, c && c.v_cn) }))
        .filter(c => has(c.k) || has(c.v));
      if (cells.length) out.push({ type: t, cells });
      continue;
    }

    if (t === 'hero_intro') {
      /* THE HIGHLIGHT PHRASE HAS TWO JOBS AND §132 ONLY DID THE SECOND ONE.
         Reported by Ash against the editor's own preview: *"it doesnt show the
         yellw mark on the live version."* The component's rule is a fork, not a
         fallback — if the phrase IS FOUND in the body it is marked INLINE, on a
         lime slab, and no kicker is drawn from it; only when it is NOT found
         does it become the kicker instead. The first draft here kept the
         fallback and dropped the marking, so a phrase the office had placed
         inside its own paragraph rendered as plain text and the slab never
         appeared on any product.

         THE FORK IS RESOLVED PER LANGUAGE, which the component never has to do:
         it picks a language first and marks one string. Here both travel, and
         an office that typed the phrase into the English body but not into the
         Chinese one gets the slab in English and the kicker in Chinese — each
         half answering for its own text rather than one deciding for both. */
      const body = pair(b.body_en, b.body_cn);
      const hl = pair(b.highlight_en, b.highlight_cn);
      const explicit = pair(b.kicker_en, b.kicker_cn);
      // Case-insensitive, as the component matches, so an office that typed the
      // phrase in a different case still gets the slab.
      const mark = (text, phrase) => {
        if (!phrase || !text) return { segs: text ? [{ hl: false, text }] : [], kicker: '' };
        const i = text.toLowerCase().indexOf(phrase.toLowerCase());
        if (i < 0) return { segs: [{ hl: false, text }], kicker: phrase };
        return {
          segs: [
            { hl: false, text: text.slice(0, i) },
            { hl: true, text: text.slice(i, i + phrase.length) },
            { hl: false, text: text.slice(i + phrase.length) },
          ].filter(x => x.text),
          kicker: '',
        };
      };
      const mEn = mark(body.en, hl.en);
      const mCn = mark(body.cn, hl.cn);
      const kicker = { en: explicit.en || mEn.kicker, cn: explicit.cn || mCn.kicker };
      const segs = { en: mEn.segs, cn: mCn.segs };
      if (has(body) || has(kicker)) out.push({ type: t, kicker, body, segs });
      continue;
    }

    if (t === 'why') {
      // Two shapes, both live: rows[{claim_en,claim_cn}] from the editor, and a
      // legacy rows_en/rows_cn pair of newline-separated strings. A reader that
      // knew one would go blank for whichever half of the catalogue saved the
      // other, which is the same trap the two ingredient types set.
      let rows = [];
      if (Array.isArray(b.rows) && b.rows.length && typeof b.rows[0] === 'object') {
        rows = b.rows.map(r => pair(r && r.claim_en, r && r.claim_cn));
      } else {
        const en = Array.isArray(b.rows_en) ? b.rows_en : txt(b.rows_en).split('\n');
        const cn = Array.isArray(b.rows_cn) ? b.rows_cn : txt(b.rows_cn).split('\n');
        const max = Math.max(en.length, cn.length);
        for (let i = 0; i < max; i++) rows.push(pair(en[i], cn[i]));
      }
      rows = rows.filter(has);
      if (rows.length) out.push({ type: t, head: HEADS.why, rows });
      continue;
    }

    if (t === 'ingredients_chips' || t === 'ingredients_line') {
      const items = (Array.isArray(b.items) ? b.items : [])
        .map(it => ({
          name_en: txt(it && it.name_en),
          name_cn: txt(it && it.name_cn),
          pct: (it && it.pct != null && it.pct !== '' && Number.isFinite(Number(it.pct)))
            ? Number(it.pct) : null,
          lead: !!(it && it.lead),
        }))
        .filter(it => it.name_en || it.name_cn);
      if (items.length) out.push({ type: t, items });
      continue;
    }

    if (t === 'allergen_card') {
      const card = {
        contains_en: splitChips(b.contains_en),
        contains_cn: splitChips(b.contains_cn),
        may_en: splitChips(b.may_contain_en),
        may_cn: splitChips(b.may_contain_cn),
      };
      if (card.contains_en.length || card.contains_cn.length ||
          card.may_en.length || card.may_cn.length) out.push({ type: t, card });
      continue;
    }

    if (t === 'how_to_use') {
      const tiles = (Array.isArray(b.tiles) ? b.tiles : [])
        .map(it => ({
          icon: icon(it && it.icon),
          lbl: pair(it && it.label_en, it && it.label_cn),
          sub: pair(it && it.sub_en, it && it.sub_cn),
        }))
        .filter(it => has(it.lbl) || it.icon);
      // The component's own grid rule: four columns at eight tiles or more,
      // three otherwise.
      if (tiles.length) {
        out.push({ type: t, head: HEADS.how_to_use, tag: TAGS.how_to_use(tiles.length),
                   tiles, cols: tiles.length >= 8 ? 4 : 3 });
      }
      continue;
    }

    if (t === 'storage_box') {
      const card = (c) => {
        if (!c) return null;
        const head = pair(c.head_en, c.head_cn);
        // num went bilingual after a legacy single `num`; both are read.
        let num = has(pair(c.num_en, c.num_cn)) ? pair(c.num_en, c.num_cn) : pair(c.num, c.num);
        let unit = pair(c.unit_en, c.unit_cn);
        if (!has(head) && !has(num) && !has(unit)) return null;
        /* THE COMPONENT PROMOTES A LONE PHRASE INTO THE HERO SLOT, and so does
           this. The card is built around a figure in `num` with `unit` as its
           caption; when the office writes only "Cool, dry place" it lands in
           `unit` and the card renders tall, mostly blank, with the real message
           in caption type. Promoting it fills the card at a readable size. */
        if (!has(num) && has(unit)) { num = unit; unit = pair('', ''); }
        /* AND IT DROPS A REPEATED SCALE. The figure already carries the degree
           mark ("0\u20134\u00b0") and the office often restates it at the head of the
           caption ("\u00b0C at all times"), so the degree shows twice. */
        const deScale = (v) => /\u00b0\s*$/.test(num.en) || /\u00b0\s*$/.test(num.cn)
          ? v.replace(/^\s*\u00b0?\s*[cf]\b\.?\s*/i, '').replace(/^\s*[\u2103\u2109]\s*/, '').trim()
          : v;
        unit = { en: deScale(unit.en), cn: deScale(unit.cn) };
        // A phrase, not a numeral: the page drops it to a wrapping size.
        const long = Math.max(num.en.replace(/\s+/g, '').length,
                              num.cn.replace(/\s+/g, '').length) > 5;
        return { icon: icon(c.icon), head, num, unit, long, alt: !!c.alt };
      };
      const left = card(b.left), right = card(b.right);
      const note = pair(b.note_en, b.note_cn);
      if (left || right || has(note)) {
        out.push({ type: t, head: HEADS.storage_box, tag: TAGS.storage_box, left, right, note });
      }
      continue;
    }

    if (t === 'notes_callout') {
      const text = pair(b.text_en, b.text_cn);
      if (has(text)) out.push({ type: t, text });
      continue;
    }

    // The legacy stat_callout renders identically and is folded in here, as the
    // component folds it.
    if (t === 'big_stat' || t === 'stat_callout') {
      const stat = txt(b.stat);
      const what = has(pair(b.claim_en, b.claim_cn)) ? pair(b.claim_en, b.claim_cn)
        : pair(b.what_en, b.what_cn);
      const claim = has(pair(b.sub_en, b.sub_cn)) ? pair(b.sub_en, b.sub_cn)
        : pair(b.claim_en, b.claim_cn);
      if (stat || has(what) || has(claim)) out.push({ type: 'big_stat', stat, what, claim });
      continue;
    }

    if (t === 'pull_quote') {
      const text = pair(b.text_en, b.text_cn), who = pair(b.who_en, b.who_cn);
      if (has(text) || has(who)) out.push({ type: t, text, who });
      continue;
    }

    if (t === 'image_band') {
      const url = txt(b.url);
      if (!url) continue;
      const ratio = ['wide', 'square', 'tall', 'natural'].indexOf(b.ratio) >= 0 ? b.ratio : 'wide';
      out.push({ type: t, url, caption: pair(b.caption_en, b.caption_cn), ratio });
      continue;
    }

    if (t === 'recipe_steps') {
      const steps = (Array.isArray(b.steps) ? b.steps : [])
        .map(x => ({ text: pair(x && x.text_en, x && x.text_cn),
                     time: pair(x && x.time_en, x && x.time_cn) }))
        .filter(x => has(x.text));
      if (!steps.length) continue;
      const title = has(pair(b.title_en, b.title_cn)) ? pair(b.title_en, b.title_cn) : HEADS.recipe;
      out.push({ type: t, head: title, tag: TAGS.recipe(steps.length), steps });
      continue;
    }

    if (t === 'pairings') {
      const items = (Array.isArray(b.items) ? b.items : [])
        .filter(it => it && it.id)
        .map(it => ({ id: Number(it.id), name: pair(it.name_en, it.name_cn) }));
      if (!items.length) continue;
      const title = has(pair(b.title_en, b.title_cn)) ? pair(b.title_en, b.title_cn) : HEADS.pairings;
      out.push({ type: t, head: title, items });
      continue;
    }

    if (t === 'faq') {
      const items = (Array.isArray(b.items) ? b.items : [])
        .map(it => ({ q: pair(it && it.q_en, it && it.q_cn), a: pair(it && it.a_en, it && it.a_cn) }))
        .filter(it => has(it.q) && has(it.a));
      if (!items.length) continue;
      const title = has(pair(b.title_en, b.title_cn)) ? pair(b.title_en, b.title_cn) : HEADS.faq;
      out.push({ type: t, head: title, items });
      continue;
    }

    if (t === 'nutrition_facts') {
      const rows = (Array.isArray(b.rows) ? b.rows : [])
        .map(r => ({ label: pair(r && r.label_en, r && r.label_cn),
                     value: txt(r && r.value),
                     kind: nutKind((r && r.label_en) || (r && r.label_cn)) }))
        .filter(r => has(r.label) || r.value);
      if (rows.length) {
        out.push({ type: t, head: HEADS.nutrition, basis: pair(b.basis_en, b.basis_cn), rows });
      }
      continue;
    }
  }
  return out;
}

module.exports = {
  ingredientsOf, allergensOf, proseOf, pageBlocks, hiddenHere, hasNutritionBlock,
  splitChips, blocksOf, PROSE_TYPES, LABELS, HEADS, ICON_FIX,
};
