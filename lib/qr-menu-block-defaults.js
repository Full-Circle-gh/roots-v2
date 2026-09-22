// WHICH BLOCK TYPES THE QR MENU DRAWS WHEN NOBODY HAS SAID OTHERWISE.
//
// ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
// Until §228 the only answer was per block, per product: `hide_qr` on the
// block, absent meaning SHOWN. There was no default anywhere, so switching a
// type off across the catalogue meant opening 216 products and clicking 216
// eyes — and every product added afterwards started from the old answer again.
//
// ── THE SEED IS READ OFF ONE PRODUCT, AND THAT IS ON PURPOSE ───────────────
// Ash, 2026-09-22: *"the blocks of quinoa salad that now show on the qr code
// menu will be the default for all products."* Quinoa Salad (#196) carries ten
// blocks and has exactly two switched off — the storage card and the notes
// callout. Read live the same day: it and Almond Banana Berry were the ONLY
// two products in the catalogue carrying a flag at all, and no product
// anywhere had switched off a type Quinoa Salad shows. So the pattern is not a
// compromise between rival arrangements; it is the only arrangement anybody
// has ever expressed, and every other product was simply never visited.
//
// ── NO ROW IS WRITTEN, AND THAT IS THE WHOLE DESIGN ────────────────────────
// An ABSENT `storefront_config` row means the seed below, not "hide nothing".
// The alternative — a migration stamping the list onto every tenant — buys
// nothing and costs the ability to change the answer by changing this file. A
// tenant that wants a different set stores the key; a tenant that wants the
// old everything-shows behaviour stores an empty array, which is honoured.
//
// ── THE PER-PRODUCT SWITCH STILL WINS, AND IT NOW HAS THREE STATES ─────────
// lib/product-blocks-read.js holds the resolution. In short: `hide_qr === true`
// hides, `hide_qr === false` shows, and ABSENT follows this list. The third
// state is what makes a default a default — before this, absent meant "shown"
// and there was nothing for a default to govern.

'use strict';

// The dotted key, in storefront_config's own convention (see loadConfig in
// routes/retail.js — dots become nesting, so this surfaces to the admin as
// config.qrMenu.hiddenBlockTypes).
const CONFIG_KEY = 'qrMenu.hiddenBlockTypes';

// Quinoa Salad's own answer, 2026-09-22. Not a guess and not a taste: these
// are the two blocks the office had switched off on the product Ash was
// looking at when he asked for it to become the rule.
const SEED_HIDDEN = Object.freeze(['storage_box', 'notes_callout']);

// A stored value is trusted only as far as it is shaped like a list of type
// names. Anything else falls back to the seed rather than to silence, because
// "the config row is malformed" and "hide nothing" are different states and
// the second is the one that would quietly put the storage card back on 216
// menus without anybody having asked.
function normalise(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const x of v) {
    const t = String(x == null ? '' : x).trim();
    if (t && out.indexOf(t) < 0) out.push(t);
  }
  return out;
}

// -> array of block type names hidden on the QR menu unless a block overrides.
// An EMPTY ARRAY is a real answer and is honoured; absent is not.
//
// TAKES A DATABASE HANDLE rather than reaching for one, so the tenant seam
// stays the caller's decision — this file is read from the public shop route
// (tdb()) and from the admin config endpoint, and those are not the same
// handle on every request.
function readHiddenTypes(db) {
  let row;
  try {
    row = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(CONFIG_KEY);
  } catch (e) {
    // No storefront_config on this handle at all — an older account database.
    return SEED_HIDDEN.slice();
  }
  if (!row) return SEED_HIDDEN.slice();
  let parsed;
  try { parsed = JSON.parse(row.value_json); } catch (e) { return SEED_HIDDEN.slice(); }
  const list = normalise(parsed);
  return list === null ? SEED_HIDDEN.slice() : list;
}

module.exports = { CONFIG_KEY, SEED_HIDDEN, readHiddenTypes, normalise };
