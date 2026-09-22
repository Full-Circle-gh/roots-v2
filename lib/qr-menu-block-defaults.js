// WHICH BLOCK TYPES THE QR MENU DRAWS WHEN NOBODY HAS SAID OTHERWISE.
//
// ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
// Until §230 the only answer was per block, per product: `hide_qr` on the
// block, absent meaning SHOWN. There was no default anywhere, so settling what
// a counter menu shows meant opening 216 products and clicking 216 eyes — and
// every product added afterwards started from the old answer again.
//
// ── IT IS AN ALLOW-LIST, AND THE FIRST DRAFT GOT THAT WRONG ────────────────
// Ash, 2026-09-22: *"check which blocks available to view of the quinoa salad
// in the QR code menu and have all the product of the main menu QR code show
// the same blocks for each product."*
//
// THE FIRST IMPLEMENTATION READ THAT AS A BLOCK-LIST — it took the two types
// Quinoa Salad has switched OFF and switched those off everywhere. That is a
// different rule and it is weaker in the way that matters: it says nothing
// about a type Quinoa Salad does not carry AT ALL. `pull_quote` (11 products,
// 4 of them listed), `recipe_steps` (8) and `ingredients_line` (1) are not on
// that product, so a block-list left them drawing — and every block type the
// editor gains next year would arrive on the counter menu switched on, which
// is the opposite of "show the same blocks".
//
// So the list below is what the menu MAY draw. A type absent from it does not
// draw unless a block says so. Ash was right and the correction is recorded in
// §230; this comment stays so the weaker reading is not re-derived.
//
// ── THE SEED IS READ OFF ONE PRODUCT ───────────────────────────────────────
// Quinoa Salad (#196) carries ten blocks, two of them switched off. The eight
// that remain are the eight below, in the order they sit on the product. Read
// live on 2026-09-22 by scripts/diagnose_qr_block_defaults.js.
//
// ── NO ROW IS WRITTEN, AND THAT IS THE WHOLE DESIGN ────────────────────────
// An ABSENT `storefront_config` row means the seed below, not "allow nothing"
// and not "allow everything". The alternative — a migration stamping the list
// onto every tenant — buys nothing and costs the ability to change the answer
// by changing this file.
//
// ── THE PER-PRODUCT SWITCH STILL WINS, AND IT NOW HAS THREE STATES ─────────
// lib/product-blocks-read.js holds the resolution. In short: `hide_qr === true`
// hides, `hide_qr === false` shows, and ABSENT asks this list. The third state
// is what makes a default a default — before this, absent meant "shown" and
// there was nothing for a default to govern.

'use strict';

// The dotted key, in storefront_config's own convention (see loadConfig in
// routes/retail.js — dots become nesting, so this surfaces to the admin as
// config.qrMenu.shownBlockTypes).
const CONFIG_KEY = 'qrMenu.shownBlockTypes';

/* QUINOA SALAD'S OWN EIGHT, in its own order. Not a taste and not a guess:
   this is what that product draws on the counter menu today, which is what Ash
   asked every product to draw.

   WHAT IS DELIBERATELY ABSENT, and each one is a real consequence rather than
   an oversight:
     storage_box      switched off on #196 by the office.
     notes_callout    switched off on #196 by the office.
     pull_quote       not on #196. 11 products carry it, 4 of them listed.
     recipe_steps     not on #196. 8 products, none currently listed.
     ingredients_line not on #196. 1 product, not currently listed — and the
                      one to watch: it is the OTHER ingredients block and
                      carries the same items as ingredients_chips, so a
                      product that used it would show no ingredients at a
                      counter. No listed product does today. If one ever is,
                      this line is where that gets decided.
     image_band, pairings, faq, stat_callout
                      supported by the reader, carried by no product in this
                      catalogue, and not on #196 either way. */
const SEED_SHOWN = Object.freeze([
  'spec_strip', 'hero_intro', 'big_stat', 'why',
  'ingredients_chips', 'allergen_card', 'how_to_use', 'nutrition_facts',
]);

// A stored value is trusted only as far as it is shaped like a list of type
// names. Anything else falls back to the seed rather than to a blank menu,
// because "the config row is malformed" and "allow nothing" are different
// states and the second empties every detail sheet in the shop.
function normalise(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const x of v) {
    const t = String(x == null ? '' : x).trim();
    if (t && out.indexOf(t) < 0) out.push(t);
  }
  return out;
}

// -> array of block type names the QR menu MAY draw, unless a block overrides.
//
// AN EMPTY ARRAY IS A REAL ANSWER and is honoured: it means no block type
// draws, and every detail sheet falls back to whatever is not a block. That is
// a drastic setting and it is reachable only by storing one deliberately —
// which is why a malformed row does NOT land there.
//
// TAKES A DATABASE HANDLE rather than reaching for one, so the tenant seam
// stays the caller's decision — this file is read from the public shop route
// (tdb()) and from the admin config endpoint, and those are not the same
// handle on every request.
function readShownTypes(db) {
  let row;
  try {
    row = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(CONFIG_KEY);
  } catch (e) {
    // No storefront_config on this handle at all — an older account database.
    return SEED_SHOWN.slice();
  }
  if (!row) return SEED_SHOWN.slice();
  let parsed;
  try { parsed = JSON.parse(row.value_json); } catch (e) { return SEED_SHOWN.slice(); }
  const list = normalise(parsed);
  return list === null ? SEED_SHOWN.slice() : list;
}

module.exports = { CONFIG_KEY, SEED_SHOWN, readShownTypes, normalise };
