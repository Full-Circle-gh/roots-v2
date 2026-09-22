// The public QR menu — docs/tacet-consolidation-decisions.md §41, §42, §44,
// §45, §47. Steps 5a and 5b of the location commerce module.
//
// WHAT THIS IS. One page, served at /s/:shopCode, that shows a shop's menu to
// a customer who has just scanned a QR code, and one endpoint,
// POST /s/:shopCode/order, that turns a selection from that menu into a
// counter order. No login, no session, no cookie and no account: a name and a
// short number are the whole of the customer's identity here (§44).
//
// THE TICKET PRINTS ON SUBMIT, not on paid (§44) — the kitchen starts making
// the drink while the customer is still walking to the till. It reuses the paid
// path's own printer, and routes/retail.js declines to print a QR order a
// second time when the cashier settles it.
//
// THE PAGE ITSELF STILL CARRIES NO CART. The submit surface is the next piece
// of Step 5b; the endpoint is built and proved first so the page has something
// correct to post to.
//
// IT IS A CUSTOMER SURFACE, NOT AN ADMIN ONE. It must look like the web
// storefront and the mini app, which share one visual language, and NOT like
// the Tacet admin, which has its own (docs/tacet-design-system.md). The two
// are different products with different readers.
//
// TENANT-THEMED, NOT ROOTS-HARDCODED (§0). There is no colour, font family,
// brand name, logo or currency symbol written into this file. Every one of
// them is read from the tenant's own storefront_config through the same
// lib/brand-theme.js map the mini app and the web storefront already share,
// so this page renders as a Roots page for Roots and as somebody else's page
// for somebody else, with no branch. The seeded Roots theme is a default, not
// a constant.
//
// SERVER-RENDERED IN ONE RESPONSE, on purpose. The customer is standing in a
// shop having just scanned a code, which is the worst possible moment for the
// blank first paint that a fetch-then-render shell gives. The precedent is the
// public tracking page in routes/retail.js, which is the one thing in this
// repo proven to render inside the WeChat in-app browser.
//
// LANGUAGE (§44, and the §26 narrowing). BOTH languages are in the DOM and CSS
// decides which is visible, rather than the server picking one. That is what
// makes the toggle a class swap instead of a reload — and a reload would
// re-run detection, which is exactly what §26's narrowing forbids once the
// reader has chosen. Resolution order: this session's toggle, then ?lang=,
// then the client's own language, then English. Detection selects the opening
// render ONLY and is never consulted again once the toggle is used.
//
// NOTHING BRANCHES ON THE USER AGENT. The page is the same bytes inside the
// WeChat browser and outside it. WeChat is the expected home, not a variant:
// a UA branch here would be a second page to keep correct, and the only
// WeChat-specific thing this page needs — the viewport line — is right for
// every phone. scripts/test_shop_menu.js holds that line.
//
// CHINESE IS COPIED, NEVER COMPOSED (§30). Every 中文 string on this page is
// already live on a customer surface in public/shop.html and is reused
// verbatim: 售罄 (sold out), 暂无商品 / 请稍后再来 (the empty menu), and the
// EN / 中 toggle labels. Category headings come from the tenant's own category
// tree and product names from the tenant's own catalogue, so neither is
// composed here either. The one label with no live source — a word for the
// uncategorised group — is NOT rendered: that group has no heading. See also
// the note on the not-found page below, which is the other place a string
// would otherwise have had to be minted.

'use strict';

const express = require('express');
const { tdb } = require('../lib/tenant-db');
const { isShopCode } = require('../lib/shop-code');
const { getCategoryTree } = require('../lib/category-tree');
const { themeToCssVars, sanitizeTheme } = require('../lib/brand-theme');
const inventory = require('../lib/inventory');
// §183 — what a product asks and whether an answer is allowed, shared with the
// counter till. Both rule sets used to live in this file: which choices a
// product still offers, and whether a posted answer is allowed. They moved
// rather than being copied; the module header says why. lib/option-limits is
// no longer required here because the one caller that used it went with them.
const productOptions = require('../lib/product-options');
// resolveProductImage and normalizeCurrency are retail.js's, exported for this
// file so the photo fallback and the money format cannot drift from the
// storefront's. routes/retail-shops.js requires retail.js the same way; both
// are mounted after it in server.js, so the module is fully loaded by then.
const {
  resolveProductImage, normalizeCurrency,
  // A QR sale and a till sale at the same counter are numbered, taxed and
  // costed by the same code. A second answer to any of the three would show up
  // as a margin report nobody can reconcile.
  nextOrderNo, taxSettings, costAtSale, optionsCostAtSale,
  // autoPrintOrder is NO LONGER IMPORTED, and its absence is the change rather
  // than an oversight: §44's print-on-submit was narrowed away on 2026-09-08 and
  // every QR ticket now comes from markOrderPaid() on the paid transition. See
  // the note at the end of the submit handler for why nothing was needed inside
  // autoPrintOrder itself for that to work.
  // §50, the in-page WeChat rail. Composed, never copied: the prepare, the
  // signing and the out_trade_no namespace are the same ones the mini app and
  // the storefront charge through, so a payment placed here settles through
  // the same callback into the same ledger.
  oaPayContext, wechatJsapiPrepare, buildWxPayParams, wxOutTradeNo, payDescription,
} = require('./retail');
const crypto = require('crypto');
const wechatOa = require('../lib/wechat-oa');
const { allocateShopOrderCode } = require('../lib/shop-order-code');
const { nutritionRows } = require('../lib/nutrition-rows');
const blockRead = require('../lib/product-blocks-read');
const qrBlockDefaults = require('../lib/qr-menu-block-defaults');
// WHAT A PRODUCT PAGE SIGNS ITSELF WITH (§158). The same module the mini app's
// storefront config and the product editor read, so this page cannot sign a
// product differently from the phone: one cast, one auto-map, one house line.
const brandSignature = require('../lib/brand-signature');
// The door that put this request into its tenant's data scope in server.js.
// Asked again here so the catalogue the page read and the signature it signs
// with can never come from two different shops.
const { resolvePublicTenant } = require('../middleware/public-tenant');
// The GLOBAL db, and `tenants` is the only thing read from it here: that table
// is not tenant-scoped, so tdb() cannot answer whose shop this is. Routed
// through the seam like every other file on the covered side of that boundary.
const { seam } = require('../lib/db-seam');
const mainDb = seam(require('../database'));
const moneyLib = require('../lib/money');   // the money MATHS; money() below is this page's formatter
const tax = require('../lib/tax');
const rateLimit = require('express-rate-limit');

let sharp = null;
try { sharp = require('sharp'); } catch (e) {
  console.warn('[shop-menu] sharp not available — menu photos serve full size:', e.message);
}

const router = express.Router();

// The channel a shop sale belongs to (§44: till and QR share one channel, and
// order source distinguishes them). Used here only to net off the right
// reservations; 'shop' carries no per-channel quota, so it reads the global
// remaining figure, which is what a menu should show.
const SHOP_CHANNEL = 'shop';

// Menu photo width. One size, because there is one layout and it is a phone.
const MENU_THUMB_W = 320;
/* THE PAGE'S HERO IS NOT A THUMBNAIL, AND IT WAS BEING SERVED ONE. §129 made the
   photo full-bleed across the top of the product page and kept the card's own
   MENU_THUMB_W on it — 320px stretched across a 390px viewport, which on a phone
   at 3x is 320 real pixels filling 1170, and reads exactly as blurred as that
   sounds. Reported by Ash: "quality of picture once open to productpage is low
   resulution". 320 is still right for the CARD, which is about 170px wide.

   IT IS THE SAME NUMBER THE ENLARGE ASKS FOR, DELIBERATELY. The image route
   caches per width and the browser caches per URL, so a hero at 900 and an
   enlarge at 1000 would be two renders, two downloads and two cache entries of
   one photograph. Sharing the width makes tapping the hero to enlarge a cache
   hit that costs nothing, and it is why both now read this constant instead of
   each carrying its own literal. The route caps at 1200 and resizes
   withoutEnlargement, so a smaller original is served at its own size rather
   than upscaled into softness. */
const HERO_W = 1000;

// ─── small helpers ──────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// One dotted storefront_config key, on the request's tenant scope. Same five
// lines routes/retail-setup.js uses; kept local so this file has no dependency
// on the setup route.
function cfg(key, dflt) {
  try {
    const row = tdb().prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
    return row ? JSON.parse(row.value_json) : dflt;
  } catch (e) { return dflt; }
}

// A bilingual span pair. BOTH sides are always emitted; CSS shows one. An
// empty side falls back to the other so a half-filled product never renders a
// blank line — the same pick() semantics public/shop.html uses. That fallback
// is a courtesy to a page already live, NOT a substitute for both names being
// present: scripts/check_shop_listing_names.js is the gate that stops a shop
// going live half-translated (§44).
function bi(en, cn) {
  const a = String(en == null ? '' : en).trim();
  const b = String(cn == null ? '' : cn).trim();
  const e = a || b, c = b || a;
  if (!e && !c) return '';
  return `<span class="l-en">${esc(e)}</span><span class="l-cn">${esc(c)}</span>`;
}

// Reported on the rail: a Chinese category name carrying "&" ("鲜食 & 熟食")
// wrapped at the rail's own narrow width with "&" stranded alone on the
// first line ("鲜食 &" / "熟食") — CJK text breaks between any two
// characters, so the greedy line-breaker fills each line as full as it can.
// A non-breaking space alone was not enough: gluing only "&" to the very
// next character ("& 熟") still let the break land between THAT character
// and the one after it ("食"), splitting the two-character word "熟食"
// itself — reported again on the actual device even though it fixed the
// specific case this was first tested against.
//
// So the whole tail from "&" to the end of the string is joined with
// U+2060 WORD JOINER between every character — a zero-width, invisible
// character whose only effect is to forbid a line break at that point
// (unlike NBSP, it adds no width, so it is safe between two CJK characters
// that never had a space there). The result is one unbreakable run from
// "&" onward: it either fits entirely on the current line, or the WHOLE of
// it — "& 熟食" together — moves to the next one. Only the space BEFORE
// "&" (kept a normal space) is still a valid break point, so a label that
// must wrap breaks there ("鲜食" / "& 熟食"), never inside the "& phrase".
function noOrphanAmp(s) {
  const str = String(s == null ? '' : s);
  const i = str.indexOf('&');
  if (i < 0) return str;
  const head = str.slice(0, i);
  const tail = str.slice(i).replace(/\s+/g, '\u00a0').split('').join('\u2060');
  return head + tail;
}

// Money in the tenant's own display currency. normalizeCurrency is retail.js's,
// so a tenant that sells in something other than yuan sees one figure format
// across the storefront, the till and this menu.
function money(n, cur) {
  const v = (Number(n) || 0).toFixed(cur.decimals);
  return cur.position === 'after' ? (v + cur.symbol) : (cur.symbol + v);
}

// The library faces this app self-hosts, family -> file under /assets/fonts.
// NOT a brand choice: it is which of lib/brand-fonts.js's library is installed,
// and a theme naming a family that is not here simply falls through to the CJK
// stack. A tenant's own uploaded face arrives instead as theme.fonts.*.url.
const INSTALLED_FACES = {
  'Bear Serif':    'BearSerif.otf',
  'Aleo':          'Aleo-Regular.otf',
  'Toni Grotesk':  'ToniGroteskPro.otf',
  'League Gothic': 'LeagueGothic.ttf',
  'Lilita One':    'LilitaOne.ttf',
  'DF Yuan':       'DFYuanW5.ttf',
};
const FACE_FORMAT = { otf: 'opentype', ttf: 'truetype', woff: 'woff', woff2: 'woff2' };

// A display face whose DIGITS do not match its letters, and the library face
// that stands in for them. A price is the second thing a customer reads, so a
// menu whose numerals are thin and geometric beside chunky letters reads as a
// mistake. app.wxss states the problem and this is the same remedy: map the
// digits, the currency signs and the ampersand to the substitute by
// unicode-range. A family that is not here simply sets its own digits.
const DIGIT_SUBSTITUTE = { 'Bear Serif': 'Lilita One' };
const DIGIT_RANGE = 'U+0024-0026, U+0030-0039, U+00A5';

// @font-face rules for the two families THIS TENANT's theme names — an
// installed library face, or the tenant's own https upload. Nothing else is
// emitted, so a tenant on a stock system font ships no font bytes at all.
function fontFaces(fonts) {
  const seen = new Set();
  const out = [];
  for (const slot of ['display', 'body']) {
    const f = fonts && fonts[slot];
    if (!f || !f.family) continue;
    const fam = String(f.family).replace(/'/g, '');
    if (seen.has(fam)) continue;
    seen.add(fam);
    let url = null;
    if (f.source === 'upload' && typeof f.url === 'string' && /^https:\/\//i.test(f.url)) url = f.url;
    else if (INSTALLED_FACES[fam]) url = '/assets/fonts/' + INSTALLED_FACES[fam];
    if (!url) continue;
    const ext = (String(url).toLowerCase().match(/\.(woff2|woff|otf|ttf)(?:[?#]|$)/) || [])[1];
    const fmt = ext ? ` format('${FACE_FORMAT[ext]}')` : '';
    // The substitute goes FIRST and carries the narrow unicode-range, so the
    // full face below it covers everything the range does not claim.
    const sub = DIGIT_SUBSTITUTE[fam];
    if (sub && INSTALLED_FACES[sub]) {
      out.push(`@font-face{font-family:'${fam}';src:url('/assets/fonts/${INSTALLED_FACES[sub]}')` +
        ` format('${FACE_FORMAT[INSTALLED_FACES[sub].split('.').pop()]}');` +
        `unicode-range:${DIGIT_RANGE};font-display:swap;}`);
    }
    out.push(`@font-face{font-family:'${fam}';src:url('${url}')${fmt};font-display:swap;}`);
  }
  return out.join('');
}

// The tenant's theme, assembled from its dotted config keys and handed to the
// shared map. sanitizeTheme inside themeToCssVars fills every missing role, so
// a tenant that has never opened Brand Studio still gets a complete palette.
function themeBits() {
  const theme = {
    palette:  cfg('theme.palette', null),
    fonts:    cfg('theme.fonts', null),
    shape:    cfg('theme.shape', null),
    density:  cfg('theme.density', null),
    audience: cfg('theme.audience', null),
  };
  // SANITISE ONCE AND USE THAT FOR BOTH. Reading the raw config for the font
  // faces while themeToCssVars sanitised its own copy meant a tenant with no
  // saved theme — which is every tenant that has never opened Brand Studio,
  // Roots included — got the DEFAULT family names in the CSS variables and no
  // @font-face for them, so the brand face silently never loaded and the page
  // fell back to a system serif. The two must see the same theme.
  const clean = sanitizeTheme(theme);
  return { vars: themeToCssVars(clean), fonts: clean.fonts };
}

// The tenant's own wordmark text, used as the document title. NOT
// tenantBrandLabel(), which answers 'Roots' for tenant 1 as a literal — this
// page must carry no such literal, so it reads the same brand row the
// storefront's own footer does and falls back to nothing rather than a name.
function brandText() {
  const f = cfg('brand.me_footer', null);
  const w = f && typeof f === 'object' ? f.wordmark_text : null;
  return (typeof w === 'string' && w.trim()) ? w.trim() : '';
}

// ─── data ───────────────────────────────────────────────────────────────

// An opaque code -> the shop, only when the shop AND its location are both
// live. Every other outcome is null, and the caller renders one page for all
// of them (see notFoundPage).
function resolveShop(code) {
  return tdb().prepare(`
    SELECT s.id, s.location_id, s.public_code, s.display_name_en, s.display_name_cn,
           l.name_en AS location_name_en, l.name_cn AS location_name_cn
      FROM shops s
      JOIN retail_stores l ON l.id = s.location_id
     WHERE s.public_code = ? AND s.is_active = 1 AND COALESCE(l.is_active, 1) = 1
  `).get(code) || null;
}

function shopName(shop) {
  return {
    en: shop.display_name_en || shop.location_name_en || '',
    cn: shop.display_name_cn || shop.location_name_cn || '',
  };
}

// THE QUESTIONS THE COUNTER WOULD HAVE ASKED (§120). Sugar level, hot or cold,
// an extra shot — `retail_product_options` + `retail_product_option_choices`,
// the same two tables the web storefront and the mini app have asked from for
// as long as either has existed. This page read neither until §120, so a
// customer standing at the counter could not say "half sugar" and a drink sold
// in three sizes took three rows of a phone screen.
//
// OPTIONS, NOT VARIANTS, and §120 gives the reason: a variant is its own
// store_products row and would need its own listing, its own line on a menu
// read by somebody standing up. An option is one card that asks.
//
// `text` OPTIONS ARE EXCLUDED and their absence is deliberate. The type is
// half-built and unsupported on BOTH existing clients — neither renders an
// input for it, and selection state everywhere is choice-id keyed, so a text
// option can only ever collect nothing (routes/retail.js says so at length
// above its own sanitiser). Rendering one here would be a third client with
// the same hole in it.
//
// AVAILABILITY IS THIS SHOP'S SHELF, NOT THE COMPANY'S. A choice carrying a
// stock_product_id is a real thing on a real shelf, and §47's rule governs it
// exactly as it governs a stocked listing: counted units AT THIS LOCATION, and
// no shelf record here at all IS sold out. The online storefront asks a
// different question of the same column (sellableStockSql, the whole company's
// count) because it has not routed to a location yet; the two are meant to
// differ and neither is to be changed to match the other.
function attachOptions(shop, listings) {
  const pids = listings.map(r => r.store_product_id);
  if (!pids.length) return;

  // THE SHELF IS THIS SHOP'S, and it is the half §183 left with the caller.
  // A choice carrying a stock_product_id is a real thing on a real shelf here;
  // a sugar level has none and is never asked about. §47 governs the verdict —
  // an absent shelf record IS sold out, not "untracked" — and the online
  // store's own sellableStockSql takes the opposite view for its own reasons.
  const addonIds = [...new Set(tdb().prepare(
    `SELECT DISTINCT c.stock_product_id
       FROM retail_product_option_choices c
       JOIN retail_product_options o ON o.id = c.option_id
      WHERE o.product_id IN (${pids.map(() => '?').join(',')})
        AND c.stock_product_id IS NOT NULL`
  ).all(...pids).map(r => r.stock_product_id))];
  const addonAvail = addonIds.length
    ? inventory.getAvailableMap(shop.location_id, addonIds, SHOP_CHANNEL)
    : new Map();
  const isChoiceSoldOut = (c) => {
    const a = addonAvail.get(c.stock_product_id);
    return !a || a.available <= 0;
  };

  const byProduct = productOptions.questionsForProducts(tdb(), pids, { isChoiceSoldOut });
  if (!byProduct.size) return;

  for (const r of listings) {
    const opts = byProduct.get(r.store_product_id);
    if (!opts || !opts.length) continue;
    r.options = opts;
    // A REQUIRED QUESTION WITH NO ANSWER LEFT TAKES THE WHOLE PRODUCT WITH IT,
    // and this is the one place §120's rule 1A stops. 1A says a sold-out paid
    // extra greys out while the drink still sells, and that holds for every
    // OPTIONAL question — nobody who did not want oat milk is turned away. But
    // a drink whose required "milk?" has run out of every milk cannot be made,
    // and the honest answer is the sold-out bar the card already knows how to
    // draw, not a picker the customer cannot satisfy.
    if (!r.sold_out && productOptions.requiredQuestionIsUnanswerable(opts)) r.sold_out = true;
  }
}

// A shop's live menu, grouped for display.
//
// AVAILABILITY IS TWO DIFFERENT QUESTIONS (§42, §47):
//   made_here — the staff switch, and nothing else. There is no material stock
//               to consult and §43 defers ever having any.
//   stocked   — the staff switch AND counted units at THIS location. A product
//               with no shelf record here at all is SOLD OUT, not "untracked":
//               §47. The online store's own sellableStockSql takes the
//               opposite view for its own reasons and the two are meant to
//               differ; neither is to be changed to match the other.
function buildMenu(shop) {
  // §129 reassigns this once, below, when variant siblings collapse.
  let listings = tdb().prepare(`
    SELECT sl.id, sl.store_product_id, sl.price, sl.fulfilment_mode, sl.is_available,
           sl.sort_position, p.name_en, p.name_cn, p.top_category, p.subcategory, p.updated_at,
           -- WHAT THE DETAIL SHEET READS, and nothing more. The office's own
           -- product blocks — the mini app draws eleven types from them and
           -- this page reads TWO, ingredients and the allergen card — plus the
           -- nutrition table. Deliberately NOT the marketing paragraph, the
           -- claims, the usage tiles or the tagline: a person standing at a
           -- counter is deciding whether they can eat it.
           --
           -- NOT product_facts.ingredients_* AND NOT free_of. The first is a
           -- second, sparser home for the same idea; the second is the filter
           -- tag set behind the storefront's GLUTEN FREE chips, where an absent
           -- tag means "not tagged" and never "contains". An earlier draft of
           -- this sheet read both and would have asserted an allergen nobody
           -- declared.
           p.description_blocks, p.nutrition,
           -- §179 — WHAT SIGNS THE SHEET. The colophon is NOT a block and never
           -- was: it is three columns on the product row over the shop's own
           -- signature. That is why the per-block "hide on the QR menu" switch
           -- does not reach it, and why the §132 sweep that brought every block
           -- here left it behind -- a rule about blocks could not see it.
           -- NOTE, and the file's own warning one screen up says why: no
           -- backtick may appear in this template literal, comments included.
           -- The category column is read for the AUTO pick alone and nowhere
           -- else on this page; the pick belongs to lib/brand-signature.
           p.category, p.colophon_character,
           p.colophon_tagline_en, p.colophon_tagline_cn,
           -- §129 — THE SIZES, WHICH §120 DECIDED NOT TO READ AND ASH REVERSED.
           -- Variants are independent product rows linked by variant_group_id,
           -- and an operator lists each one separately. Without variant_label
           -- the menu drew two cards with the same photograph and the same
           -- name at two different prices, and the size written nowhere: not a
           -- choice
           -- presented badly, a duplicate listing. variant_sort is the
           -- operator's own drag-to-reorder position in the back office and is
           -- what orders the picker.
           p.variant_group_id, p.variant_label, p.variant_label_cn, p.variant_sort,
           -- Does a photo EXIST for this product? Mirrors resolveProductImage,
           -- including its variant-sibling fallback, so the two never disagree.
           -- Asked here because the alternative is an <img> pointing at a route
           -- that 404s, which a phone draws as a broken-image glyph on the menu.
           (CASE WHEN (p.image_data IS NOT NULL AND p.image_data != '')
                   OR (p.image_url  IS NOT NULL AND p.image_url  != '')
                   OR (p.variant_group_id IS NOT NULL AND EXISTS (
                        SELECT 1 FROM store_products sib
                         WHERE sib.variant_group_id = p.variant_group_id
                           AND COALESCE(sib.is_active, 1) = 1
                           AND ((sib.image_data IS NOT NULL AND sib.image_data != '')
                             OR (sib.image_url  IS NOT NULL AND sib.image_url  != ''))))
                 THEN 1 ELSE 0 END) AS has_photo
      FROM shop_listings sl
      JOIN store_products p ON p.id = sl.store_product_id
     WHERE sl.shop_id = ? AND COALESCE(p.is_active, 1) = 1
     ORDER BY sl.sort_position ASC, sl.id ASC
  `).all(shop.id);
  if (!listings.length) return [];

  const stockedIds = listings.filter(r => r.fulfilment_mode === 'stocked').map(r => r.store_product_id);
  const avail = stockedIds.length
    ? inventory.getAvailableMap(shop.location_id, stockedIds, SHOP_CHANNEL)
    : new Map();

  for (const r of listings) {
    if (!r.is_available) { r.sold_out = true; continue; }
    if (r.fulfilment_mode !== 'stocked') { r.sold_out = false; continue; }
    const a = avail.get(r.store_product_id);
    r.sold_out = !a || a.available <= 0;      // absent shelf record IS sold out — §47
  }

  attachOptions(shop, listings);

  /* §129 · SIBLINGS COLLAPSE INTO ONE CARD, by the mini app's own grid rule
     (miniapp/pages/shop/shop.js _collapseVariants): group by variant_group_id,
     the representative is the group owner where it is listed and otherwise the
     lowest variant_sort, and the members keep the operator's order.

     ONLY WHEN TWO OR MORE ARE ACTUALLY LISTED ON THIS SHOP. A group whose other
     sizes the operator did not put on this menu is not a group here — it is a
     plain product, and giving it a picker with one answer in it would be asking
     a question that has no second side. This is why the grouping is done over
     `listings` and never over the catalogue.

     THE MEMBERS ARE THE WHOLE ROWS, not a trimmed summary, because each sibling
     carries its OWN price, its OWN availability and its OWN options: a 250g jar
     can be sold out while the 500g is not, and choosing a size has to add THAT
     product at THAT price and then ask THAT product's questions. An earlier
     shape carried {id,label,price} and could not have done the last of those.

     SOLD OUT ONLY WHEN EVERY SIZE IS. One size being out is what the picker
     greys, not what removes the card — the same relation §120's rule 1A has
     between a dead extra and the drink it belongs to. */
  const vGroups = new Map();
  for (const r of listings) {
    if (!r.variant_group_id) continue;
    if (!vGroups.has(r.variant_group_id)) vGroups.set(r.variant_group_id, []);
    vGroups.get(r.variant_group_id).push(r);
  }
  const vSeen = new Set();
  const collapsed = [];
  for (const r of listings) {
    const gid = r.variant_group_id;
    const members = gid ? vGroups.get(gid) : null;
    if (!members || members.length < 2) { collapsed.push(r); continue; }
    if (vSeen.has(gid)) continue;
    vSeen.add(gid);
    const sorted = members.slice().sort((a, b) =>
      ((a.variant_sort == null ? 0 : a.variant_sort) - (b.variant_sort == null ? 0 : b.variant_sort)) ||
      String(a.variant_label || '').localeCompare(String(b.variant_label || '')) ||
      (a.store_product_id - b.store_product_id));
    const rep = sorted.find(m => m.store_product_id === gid) || sorted[0];
    collapsed.push(Object.assign({}, rep, {
      variants: sorted,
      sold_out: sorted.every(m => m.sold_out),
    }));
  }
  listings = collapsed;

  // TWO LEVELS, because that is what the shop already is. The tenant's own
  // category tree gives the rail its top categories and each section its
  // subcategory heading — the same shape miniapp/pages/shop reads, so a
  // customer who knows the online shop recognises this one.
  //
  // A listing with no subcategory sits in a section headed by its top
  // category; one with no top category at all falls to a trailing OTHER
  // band, exactly as the shop's own orphan handling does. Nothing is
  // invented for either: OTHER / 其他 and ALL / 全部 are the shop's own
  // labels, copied.
  const tree = getCategoryTree(tdb());
  const cats = [];
  const byTop = new Map();
  for (const t of tree) {
    const cat = { id: 'c' + cats.length, en: t.name, cn: t.name_cn || '', subs: t.subs || [], sections: [] };
    byTop.set(t.name, cat);
    cats.push(cat);
  }
  const other = { id: 'other', en: 'OTHER', cn: '其他', subs: [], sections: [] };

  for (const r of listings) {
    const cat = (r.top_category && byTop.get(r.top_category)) || other;
    const subNode = cat.subs.find(x => x.name === r.subcategory) || null;
    const key = subNode ? subNode.name : '';
    let sec = cat.sections.find(x => x.key === key);
    if (!sec) {
      sec = {
        key,
        en: subNode ? subNode.name : (cat === other ? '' : cat.en),
        cn: subNode ? (subNode.name_cn || '') : (cat === other ? '' : cat.cn),
        items: [],
      };
      cat.sections.push(sec);
    }
    sec.items.push(r);
  }
  // Sections follow the tree's own subcategory order, not the order products
  // happened to be listed in.
  for (const cat of cats) {
    const order = new Map(cat.subs.map((x, i) => [x.name, i]));
    cat.sections.sort((a, b) => (order.has(a.key) ? order.get(a.key) : -1) - (order.has(b.key) ? order.get(b.key) : -1));
  }
  const out = cats.filter(c => c.sections.length);
  if (other.sections.length) out.push(other);
  return out;
}

// The count beside a section heading, zero-padded to two digits — the shop's
// own countStr treatment.
function pad2(n) { return n < 10 ? '0' + n : String(n); }

// ─── page ───────────────────────────────────────────────────────────────

const VIEWPORT = 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no';

// NOTHING REACHING THE <style> ELEMENT MAY CLOSE IT.
//
// The values below are operator-authored config, not customer input, but they
// are not validated for this context: lib/brand-theme.js's cleanHex passes any
// string beginning "rgb" or "hsl" through whole, and cleanFont keeps 80
// characters of a family name having stripped only apostrophes. Neither is
// wrong — their consumers set CSS variables from JavaScript, where a stray
// angle bracket is inert. This page is the first to INLINE them into markup,
// so it is the first place where "</style>" in a palette value would be script
// on a public page. Stripped here rather than in brand-theme, because the
// hazard belongs to this context and not to the values.
function cssSafe(s) { return String(s == null ? '' : s).replace(/[<>]/g, ''); }

function styles(vars, faces) {
  // The shop's own visual language, not a second one invented for this page:
  // a 92px category rail on the oat ground with a lime active tab, a paler
  // content pane, letterspaced olive section kickers with a zero-padded count,
  // squared photo cards, and the sold-out bar laid across the bottom of the
  // photo. Values are the mini-app shop's (miniapp/pages/shop/shop.wxss,
  // converted from rpx at a 390px phone) and public/shop.html's, so a customer
  // who knows the online shop recognises the counter menu as the same shop.
  //
  // Every colour and family is still a token from the tenant's theme. The only
  // literals are neutral veils and the black sold-out scrim.
  // NO BACKTICK EITHER, comments included: this whole stylesheet is one JS
  // template literal, so a backtick around a word in a CSS comment ends the
  // string and the file stops parsing. Quoting a field name that way cost one
  // round here.
  //
  // NO ANGLE BRACKET MAY APPEAR ANYWHERE IN THIS STYLESHEET, comments included.
  // cssSafe() strips them from injected config, and scripts/test_shop_menu.js
  // asserts the whole sheet is free of them — a coarse rule on purpose, because
  // the thing it protects is that no markup can be built out of a tenant's own
  // palette or font name. It costs the child combinator (a > b), which nothing
  // here needs, and it costs "->" in a comment, which is how it was tripped: an
  // arrow in a note about rpx conversion went red as a security failure.
  return `${cssSafe(faces)}
:root{${cssSafe(vars)};--barh:58px;--cbarh:0px;--u:calc(100vw / 390)}
/* THE OFFICE'S BLOCKS SCALE WITH THE PHONE, BECAUSE THE MINI APP'S DO.
   Every length under §132 below is written calc(N * var(--u)), where N is the
   number this file already held and --u is 1px on the 390px phone the whole
   conversion was measured at. So at 390 the blocks render byte-identical to
   what they rendered before, and on any other phone they track the mini app
   instead of standing still: rpx IS screen-width/750, so a 412px Android draws
   the app's product page about 6% larger than a 390px one and drew this page at
   exactly the same size as a 390px one. Ash, on the live menu: "fix the scale".

   ONLY THE BLOCKS. The menu grid card is NOT converted from rpx and must not
   be — it is public/shop.html's .sl-* card copied in CSS pixels, and the note
   over .grid records two rounds of "it is too big" that came from treating an
   rpx conversion as its truth. The bar, the basket, the sheet chrome and the
   product name are the same: measured for a browser, and left alone.

   THE THREE FULL-BLEED SLABS KEEP A FIXED -14px, and .pb-band-cap a fixed 14px
   gutter, because both are measured against .sheet-b's own padding rather than
   against the component. Scaling them overhangs that padding on every phone
   wider than 390 and the page scrolls sideways. Hairline borders, the 999px
   pills and the how-to-use grid's 1px gridline stay fixed for the same kind of
   reason: they are a browser's units, not the design's.

   CAPPED AT 430px, the widest phone. Above that this is somebody looking at a
   QR menu on a desktop, and an uncapped 100vw/390 would draw them a poster.

   WHAT THIS COSTS, stated because the file states it everywhere else: the
   whole-pixel line boxes .dt-k and .alab argue for are whole only at 390 now.
   Off it the blocks land on fractions, which is what the mini app and
   public/shop/product-blocks.css (--u: 100vw/750) have always done. The chip
   centring those notes were really protecting is a ratio — line-height:normal
   and the CJK bracket trim — and survives any scale. Reverting is this one
   declaration: set --u to 1px and the file is back to a fixed 390px phone. */
@media (min-width:430px){:root{--u:1.1px}}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{background:var(--oat);color:var(--ink);font-family:var(--f-aleo);
  font-size:15px;line-height:1.45;-webkit-font-smoothing:antialiased}
img{display:block;max-width:100%}
.lang-en .l-cn,.lang-cn .l-en{display:none}

.bar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:12px;
  padding:calc(13px + env(safe-area-inset-top)) 14px 13px;
  background:var(--oat);border-bottom:2px solid var(--ink)}
.nm{flex:1;min-width:0;font-family:var(--f-bear);font-size:21px;line-height:1.1;
  overflow-wrap:anywhere}
.lang{flex:none;display:inline-flex;border:2px solid var(--ink);overflow:hidden;
  background:rgba(255,255,255,.72)}
.lang button{border:0;background:transparent;padding:6px 10px;font:inherit;
  font-family:var(--f-bear);font-size:13px;letter-spacing:.04em;color:var(--olive);cursor:pointer}
.lang button.on{background:var(--lime);color:var(--ink)}

.wrap{display:flex;align-items:stretch;min-height:100vh}

/* ── the product sheet ──
   Layout B, chosen 2026-09-06: a small square photo with the name and the
   allergen chips beside it, so the answer to "can I eat this" is on screen
   without scrolling, then what is in it, then the nutrition table. The photo
   is small BECAUSE it is tappable — B's own weakness is that a shrunk photo
   stops selling, and the enlarge is what buys it back. */
.it.has-dt{cursor:pointer}
.dt-top{display:flex;gap:11px;align-items:flex-start}
.dt-ph{flex:none;width:88px;height:88px;padding:0;border:2px solid var(--ink);
  background:var(--oat);overflow:hidden;cursor:zoom-in;
  -webkit-tap-highlight-color:transparent}
.dt-ph img{width:100%;height:100%;object-fit:cover}
.dt-ph.empty{cursor:default}
.dt-hd{flex:1;min-width:0}
.dt-nm{font-family:var(--f-bear);font-size:19px;line-height:1.15;overflow-wrap:anywhere}

/* ── §129 · IT IS A PAGE, NOT A SHEET ──
   Ash, on the live menu: *"why its even doing a pop up for a product, i want a
   complete page, same as the mini app."* §120 chose Layout B — a small square
   photo with the name beside it — and recorded the weakness it was accepting:
   "a shrunk photo stops selling, and the enlarge is what buys it back." A page
   does not have to accept it. The photo goes full width at the top, the name
   goes large underneath, and the enlarge stays for the customer who wants it.

   THE SAME ELEMENT IS PROMOTED RATHER THAN REPLACED. #dsheet keeps its markup,
   its open path and its template clone; these rules change what it looks like
   and nothing about what it is, so one renderer still draws one product. A
   second full-page renderer beside the sheet would have drifted from it.

   THE SCRIM IS GONE because a page has nothing behind it to dim, and the panel
   takes the whole height. z-index is BELOW the basket's: the option picker and
   the size picker are sheets that open OVER this page, and at equal z-index the
   later element in the document wins — which is this one. */
#dsheet{align-items:stretch;z-index:38}
#dsheet .sheet-bg{display:none}
#dsheet .sheet-p{height:100%;max-height:none;border-top:0}
#dsheet .sheet-h{padding-top:calc(12px + env(safe-area-inset-top))}
/* FULL-BLEED, OUT THROUGH THE SCROLLER'S OWN PADDING. .sheet-b pads 4px 14px
   for text; the hero is the one thing that should touch both edges. */
#dsheetB .dt-top{display:block}
#dsheetB .dt-ph{display:block;width:calc(100% + 28px);height:auto;
  margin:-4px -14px 0;aspect-ratio:1/1;border:0;border-bottom:2px solid var(--ink)}
#dsheetB .dt-ph.empty{aspect-ratio:auto;height:0;border-bottom:0}
#dsheetB .dt-hd{padding-top:15px}
/* THE LINE BOXES ARE WHOLE PIXELS, and that is not fussiness. 26px at 1.08 is
   28.08px, and 14px at 1.55 is 21.7px; a name that wraps to two lines then
   puts everything below it on a fractional offset, and the allergen chip's ink
   lands half a pixel off the middle of its pill. The suite measures that ink
   in a screenshot and caught it at 0.875px against a 0.75px tolerance — the
   same check whose own header records six CI failures nobody could explain.
   Stated in px rather than a ratio so it cannot drift back. */
#dsheetB .dt-nm{font-size:26px;line-height:28px}

/* The office's own paragraph. No heading over it — it names itself, and a
   label invented to sit above it would be a composed string for nothing. The
   kicker, where the office wrote one, wears the same olive kicker .dt-k does. */
.dt-p{margin-top:15px}

/* ===== §132 · THE REST OF THE OFFICE'S BLOCKS =====================
   Ash: *"i want you to build the blocks of the product description same as the
   mini app."* §129 drew two of them — the paragraph and the note — and left the
   other eleven on the floor.

   CONVERTED FROM miniapp/components/product-blocks/product-blocks.wxss AT A
   390px PHONE, which is the same rpx-times-0.52 this page used for the option
   picker. Three substitutions run through all of it, and they are the ones this
   page has always made:
     f-toni and f-gothic are not tokens here    -- both become --f-bear, which
       is what every uppercase kicker on this page already wears.
     --ink-12 (the app's hairline)              -- rgba(0,0,0,.08), this sheet's
       own hairline, used by .ln and .og.
     --ink-60 (the app's muted ink)             -- var(--olive), this page's.
   Nothing else is reinterpreted: the paddings, the grids, the huge numerals and
   the rules between rows are the component's, scaled.

   BLOCKS THAT BLEED DO IT THROUGH .sheet-b's OWN PADDING. The scroller pads
   4px 14px for text; the slab, the quote and the photo band are full-width in
   the mini app and stay full-width here, which is what the negative margin is
   for — the same trick the hero already uses. */

/* EVERY BLOCK IS A BAND, WITH AIR AROUND IT AND A RULE BETWEEN.
   Ash, against the live Ramada menu: the blocks are very tight. The component
   gives each block 60rpx of padding above and below and divides them with a
   rule (public/shop/product-blocks.css, .spb). §132 brought the thirteen
   blocks here and left the bands behind: they were emitted flat, one after
   another, so the only space between two sections was whatever the NEXT one's
   root element happened to carry — 18u under the allergen card, 26u under a
   heading, 14u under the nutrition table, and nothing at all for a block whose
   root had no margin. The chip cloud, the allergen card and the usage tiles
   therefore read as one continuous column rather than three sections.

   A HAIRLINE, NOT THE COMPONENT'S INK RULE. The component draws 2rpx of full
   ink across a 750rpx canvas. At this page's 390px the same weight reads as a
   fence between every pair of sections, and this sheet already has a divider
   for exactly this job: rgba(0,0,0,.08), what .ln and .og use.

   THE WRAPPER OWNS THE SPACE AND THE BLOCK ROOTS GIVE THEIRS UP. Without the
   reset below the wrapper's 26u and .pb-h's own 26u stack to 52u above a
   heading and only above a heading, which trades one unevenness for another.
   The roots are named rather than reached for with a child combinator, because
   no angle bracket may appear in this stylesheet — see the note at the head of
   styles(). Every class listed is a block's FIRST element by construction (one()
   emits head() first where a block has a head), so a descendant selector picks
   the same element the combinator would have. */
.pb{margin-top:calc(20 * var(--u))}
.pb + .pb{margin-top:calc(26 * var(--u));padding-top:calc(26 * var(--u));
  border-top:1px solid rgba(0,0,0,.08)}
.pb .pb-spec,.pb .dt-p,.pb .pb-why-h,.pb .pb-h,.pb .acard,.pb .pb-note,
.pb .pb-stat,.pb .pb-qt,.pb .pb-band,.pb .nut{margin-top:0}
/* margin-top and margin-bottom as LONGHANDS, never the margin shorthand: the
   slab, the quote and the photo band carry -14px on the sides to bleed out
   through .sheet-b's padding, and a shorthand here would take it back. */
.pb .pb-stat,.pb .pb-qt{margin-bottom:0}

/* The heading two-thirds of these blocks share. */
.pb-h{display:flex;justify-content:space-between;align-items:flex-end;
  margin:calc(26 * var(--u)) 0 calc(19 * var(--u));gap:calc(10 * var(--u))}
.pb-h-l{font-family:var(--f-bear);font-size:calc(27 * var(--u));line-height:1;overflow-wrap:anywhere}
.pb-h-r{flex:none;font-family:var(--f-bear);font-size:calc(10 * var(--u));letter-spacing:.22em;
  text-transform:uppercase;color:var(--olive);padding-bottom:calc(3 * var(--u))}

/* 01 · SPEC STRIP — three cells divided by hairlines. */
.pb-spec{display:grid;grid-template-columns:1fr 1fr 1fr;margin-top:calc(15 * var(--u));
  border-top:1px solid rgba(0,0,0,.08);border-bottom:1px solid rgba(0,0,0,.08)}
.pb-spec-c{padding:calc(15 * var(--u)) calc(10 * var(--u)) calc(17 * var(--u));display:flex;flex-direction:column;gap:calc(6 * var(--u));
  border-right:1px solid rgba(0,0,0,.08);min-width:0}
.pb-spec-c:last-child{border-right:0}
.pb-spec-k{font-family:var(--f-bear);font-size:calc(9.5 * var(--u));line-height:calc(12 * var(--u));
  letter-spacing:.22em;text-transform:uppercase;color:var(--olive);
  overflow-wrap:anywhere}
.pb-spec-v{font-family:var(--f-bear);font-size:calc(15.5 * var(--u));line-height:calc(18 * var(--u));
  overflow-wrap:anywhere}

/* 03 · WHY — a numbered claim per row. The FIRST rule is ink and the rest are
   hairlines, which is the component's own weighting: the list starts at a real
   edge and the rows inside it are only separated. */
/* THE HEADING IS A KICKER HERE AND A HEADLINE NOWHERE ELSE, and that is the
   component's own distinction rather than a size picked on this page: .pb-why
   is the ONE block whose head is 22rpx uppercase (.pb-why-head-l) while every
   other block's is the 52rpx .pb-section-h3. The list names itself quietly and
   the claims under it carry the weight. This page had the two exactly swapped
   -- the why block wore the big shared .pb-h headline and the ingredient cloud
   wore a small .dt-k kicker -- so a customer comparing the menu against the
   mini app read a different page. Reported by Ash against the live menu.
   Whole-pixel line-height for the reason .dt-k states at length. */
.pb-why-h{font-family:var(--f-bear);font-size:calc(11.4 * var(--u));line-height:calc(15 * var(--u));
  letter-spacing:.22em;text-transform:uppercase;color:var(--olive);
  margin:calc(21 * var(--u)) 0 calc(15 * var(--u));overflow-wrap:anywhere}
/* THE NUMERAL IS CENTRED ON THE CLAIM, NOT SAT ON ITS BASELINE. Baseline is
   the component's own alignment and it is correct to the letter: measured on
   the rendered page the two baselines land on the same pixel. It still reads
   as misaligned, and the reason is the substitution above -- the numeral is
   the display face at 33px against a 16.5px claim, roughly twice the cap
   height, so baseline-aligned its ink centre sits ~7px ABOVE the claim's and
   the number floats over the text rather than beside it. Reported by Ash
   against this menu, 2026-09-22, chosen from a rendered comparison of four
   alignments. align-items:center alone does it -- measured off the pixels
   at 8x, the numeral's ink centre lands within a pixel of the claim's
   cap-band centre on both one- and two-line claims, so there is no nudge
   here to drift when the sizes change. Its cost, which Ash was shown and
   accepted: a two-line claim is taller, so its numeral sits lower and the
   rail is no longer a straight column. miniapp/components/product-blocks/product-blocks.wxss
   carries the same change on the same block. */
.pb-why-r{display:grid;grid-template-columns:calc(37 * var(--u)) 1fr;gap:calc(14 * var(--u));align-items:center;
  padding:calc(14 * var(--u)) 0;border-top:1px solid rgba(0,0,0,.08)}
.pb-why-r.first{border-top:2px solid var(--ink)}
.pb-why-n{font-family:var(--f-bear);font-size:calc(33 * var(--u));line-height:calc(28 * var(--u))}
/* THE CLAIM IS THE COMPONENT'S f-toni, WHICH IS f-bear HERE -- the substitution
   this sheet makes everywhere else and had missed only here, so the claim fell
   through to the body face and read as prose. .pb-faq-q is the precedent: a
   whole sentence in f-toni wears f-bear on this page too. 32rpx x .52. */
.pb-why-c{font-family:var(--f-bear);font-size:calc(16.5 * var(--u));line-height:calc(22 * var(--u));
  overflow-wrap:anywhere}

/* 06 · HOW TO USE — a tile grid whose gridlines ARE the background showing
   through a 1px gap, which is how the component draws it too. */
.pb-how{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;
  background:rgba(0,0,0,.08);border:1px solid rgba(0,0,0,.08)}
.pb-how.c4{grid-template-columns:repeat(4,1fr)}
.pb-how-t{background:var(--oat);padding:calc(19 * var(--u)) calc(6 * var(--u)) calc(17 * var(--u));text-align:center;
  display:flex;flex-direction:column;gap:calc(8 * var(--u));align-items:center;
  justify-content:center;min-height:calc(79 * var(--u));min-width:0}
.pb-how-i{font-size:calc(25 * var(--u));line-height:calc(25 * var(--u))}
.pb-how-l{font-family:var(--f-bear);font-size:calc(12.5 * var(--u));line-height:calc(15 * var(--u));
  letter-spacing:.14em;text-transform:uppercase;overflow-wrap:anywhere}
.pb-how-s{font-style:italic;font-size:calc(12.5 * var(--u));line-height:calc(16 * var(--u));color:var(--olive);
  margin-top:calc(-4 * var(--u));overflow-wrap:anywhere}

/* 07 · STORAGE — two cards, one optionally inverted, with a hero figure.
   min-width:0 on the cards is load-bearing and the component says why: a grid
   item refuses to shrink below its widest unbreakable child, which is what let
   a long figure push past the card edge and clip. */
.pb-store{display:grid;grid-template-columns:1fr 1fr;gap:calc(10 * var(--u))}
.pb-store-c{border:1px solid var(--ink);padding:calc(19 * var(--u)) calc(16 * var(--u)) calc(18 * var(--u));position:relative;
  display:flex;flex-direction:column;gap:calc(9 * var(--u));min-height:calc(146 * var(--u));min-width:0;
  overflow:hidden}
.pb-store-c.alt{background:var(--ink);color:var(--oat)}
.pb-store-i{position:absolute;top:calc(12 * var(--u));right:calc(12 * var(--u));font-size:calc(19 * var(--u));line-height:calc(19 * var(--u))}
.pb-store-h{font-family:var(--f-bear);font-size:calc(11.5 * var(--u));line-height:calc(14 * var(--u));
  letter-spacing:.22em;text-transform:uppercase;overflow-wrap:anywhere}
.pb-store-n{font-family:var(--f-bear);font-size:calc(50 * var(--u));line-height:calc(48 * var(--u));margin-top:auto;
  overflow-wrap:break-word;word-break:break-word}
.pb-store-n.long{font-size:calc(24 * var(--u));line-height:calc(27 * var(--u))}
.pb-store-u{font-family:var(--f-bear);font-size:calc(12.5 * var(--u));line-height:calc(19 * var(--u));
  letter-spacing:.16em;text-transform:uppercase;overflow-wrap:anywhere}
.pb-store-note{margin-top:calc(12 * var(--u));font-style:italic;font-size:calc(12.5 * var(--u));line-height:calc(18 * var(--u));
  color:var(--olive);text-align:right;overflow-wrap:anywhere}

/* 09 · NOTES — an olive asterisk, never a bullet, and italic. The mark is a
   real span rather than a ::before so it can be read back and measured. */
.pb-note{margin-top:calc(24 * var(--u));display:flex;gap:calc(8 * var(--u));font-style:italic;font-size:calc(13 * var(--u));
  line-height:calc(20 * var(--u));color:var(--olive)}
.pb-note-m{flex:none;font-style:normal}
.pb-note-t{min-width:0;overflow-wrap:anywhere}

/* +1 · BIG STAT — a full-bleed lime slab with a very large figure and two
   dots anchoring it. Real spans, same reason as the sheet's own drawn cross. */
.pb-stat{margin:calc(26 * var(--u)) -14px;padding:calc(40 * var(--u)) calc(23 * var(--u)) calc(42 * var(--u));background:var(--lime);
  color:var(--ink);text-align:center;position:relative;overflow:hidden}
.pb-stat-n{font-family:var(--f-bear);font-size:calc(114 * var(--u));line-height:calc(97 * var(--u));
  letter-spacing:-.02em;overflow-wrap:anywhere}
.pb-stat-w{font-family:var(--f-bear);font-size:calc(11.5 * var(--u));line-height:calc(15 * var(--u));
  letter-spacing:.32em;text-transform:uppercase;margin-top:calc(10 * var(--u));
  overflow-wrap:anywhere}
.pb-stat-c{font-style:italic;font-size:calc(14.5 * var(--u));line-height:calc(20 * var(--u));margin-top:calc(6 * var(--u));
  overflow-wrap:anywhere}
.pb-stat-d{position:absolute;top:50%;margin-top:calc(-31 * var(--u));font-family:var(--f-bear);
  font-size:calc(62 * var(--u));line-height:calc(62 * var(--u))}
.pb-stat-d1{left:calc(14 * var(--u))}
.pb-stat-d2{right:calc(14 * var(--u))}

/* +2 · PULL QUOTE — a quieter ground, no border. The curly quotes are drawn
   around the text by the renderer rather than by CSS content, so both halves of
   the bilingual pair carry their own and neither shows through the other. */
.pb-qt{margin:calc(26 * var(--u)) -14px;padding:calc(25 * var(--u)) calc(23 * var(--u)) calc(27 * var(--u));background:rgba(0,0,0,.04)}
.pb-qt-p{font-style:italic;font-size:calc(15.5 * var(--u));line-height:calc(23 * var(--u));overflow-wrap:anywhere}
.pb-qt-w{margin-top:calc(10 * var(--u));font-family:var(--f-bear);font-size:calc(10 * var(--u));
  letter-spacing:.22em;text-transform:uppercase;color:var(--olive);
  overflow-wrap:anywhere}

/* +3 · IMAGE BAND — full-bleed, cropped to the shape the office chose.
   aspect-ratio rather than the component's fixed heights, because this page is
   not fixed at 750rpx and a height in px would crop differently on every phone. */
.pb-band{margin:calc(26 * var(--u)) -14px 0}
.pb-band img{display:block;width:100%;height:100%;object-fit:cover}
.pb-band-f{width:100%}
.pb-band.wide .pb-band-f{aspect-ratio:16/9}
.pb-band.square .pb-band-f{aspect-ratio:1/1}
.pb-band.tall .pb-band-f{aspect-ratio:4/5}
.pb-band.natural .pb-band-f{aspect-ratio:auto}
.pb-band.natural img{height:auto}
.pb-band-cap{padding:calc(8 * var(--u)) 14px 0;font-style:italic;font-size:calc(12.5 * var(--u));line-height:calc(19 * var(--u));
  color:var(--olive);overflow-wrap:anywhere}

/* +4 · RECIPE STEPS — an olive numeral rail, and a timing pill where the
   office gave one. */
.pb-step{display:grid;grid-template-columns:calc(37 * var(--u)) 1fr;gap:calc(14 * var(--u));padding:calc(14 * var(--u)) 0;
  border-top:1px solid rgba(0,0,0,.08)}
.pb-step.first{border-top:2px solid var(--ink)}
.pb-step-n{font-family:var(--f-bear);font-size:calc(29 * var(--u));line-height:calc(26 * var(--u));color:var(--olive)}
.pb-step-b{display:flex;flex-direction:column;align-items:flex-start;gap:calc(7 * var(--u));min-width:0}
.pb-step-t{font-size:calc(14.5 * var(--u));line-height:calc(22 * var(--u));overflow-wrap:anywhere}
.pb-step-time{font-family:var(--f-bear);font-size:calc(11.5 * var(--u));line-height:calc(14 * var(--u));
  letter-spacing:.18em;text-transform:uppercase;color:var(--olive);
  background:rgba(204,217,0,.28);padding:calc(3 * var(--u)) calc(9 * var(--u));border-radius:999px}

/* +5 · GOES WELL WITH — a row that scrolls sideways. overscroll-behavior-x
   keeps that gesture off the page behind it, the same containment the sheet's
   own scroller uses. */
/* align-items:flex-start, AND THE TILE HAS ITS OWN FRAME RATHER THAN THE MENU
   CARD'S .ph. Borrowing .ph looked like reuse and was coupling: it carries the
   grid card's 4/5 ratio and an img at height:100%, so inside a stretched flex
   item the frame grew to the tallest tile in the row and the photo grew with
   it — a 104px tile with a 250px picture in it. A cross-sell thumbnail is a
   square of its own and now says so. */
.pb-pair{display:flex;align-items:flex-start;gap:calc(10 * var(--u));overflow-x:auto;
  overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch;padding-bottom:calc(4 * var(--u))}
.pb-pair-t{flex:none;width:calc(104 * var(--u))}
.pb-pair-f{width:calc(104 * var(--u));height:calc(104 * var(--u));border-radius:calc(10 * var(--u));overflow:hidden;
  background:rgba(0,0,0,.08)}
.pb-pair-f img{width:100%;height:100%;object-fit:cover;display:block}
.pb-pair-n{margin-top:calc(7 * var(--u));font-family:var(--f-bear);font-size:calc(13 * var(--u));line-height:calc(17 * var(--u));
  overflow-wrap:anywhere}

/* +6 · QUESTIONS — real details/summary, so it opens with no script at all and
   answers a keyboard. The component's accordion needs a tap handler; this does
   not, and a customer with JavaScript off can still read every answer. */
.pb-faq{border-top:2px solid var(--ink)}
.pb-faq+.pb-faq{border-top:1px solid rgba(0,0,0,.08)}
.pb-faq summary{display:flex;justify-content:space-between;align-items:center;
  gap:calc(12 * var(--u));padding:calc(15 * var(--u)) 0;cursor:pointer;list-style:none}
.pb-faq summary::-webkit-details-marker{display:none}
.pb-faq-q{flex:1;min-width:0;font-family:var(--f-bear);font-size:calc(14 * var(--u));line-height:calc(19 * var(--u));
  overflow-wrap:anywhere}
.pb-faq-m{flex:none;font-family:var(--f-bear);font-size:calc(23 * var(--u));line-height:calc(23 * var(--u));
  color:var(--olive)}
.pb-faq[open] .pb-faq-m .l-plus{display:none}
.pb-faq .pb-faq-m .l-minus{display:none}
.pb-faq[open] .pb-faq-m .l-minus{display:inline}
.pb-faq-a{padding:0 0 calc(15 * var(--u));font-size:calc(14 * var(--u));line-height:calc(22 * var(--u));overflow-wrap:anywhere}

/* +7 · THE COLOPHON — the signature at the foot of the page (§179).
   NOT a block, which is why §132 missed it: the other fourteen rules in this
   sheet convert a block component and this one converts .colophon out of
   miniapp/pages/product/product.wxss, at the same rpx times 0.52.

   NO FILL, AND THE FILL IT USED TO CARRY WAS REPORTED FROM A PHONE. The mini
   app fills this slab with --oat against a --paper page — one gentle warm step
   off the ground it sits on. THIS sheet's own panel is already --oat, so an oat
   slab here would be no slab at all, and the first pass took rgba(0,0,0,.04)
   instead to keep a slab visible. That is a wash of PURE BLACK over a warm
   surface: same hue, a shade darker, and read against the surface beside it as
   grey. On the phone it is a taupe rectangle behind the character, and the
   character looks like it arrived in a box of somebody else's colour. The
   brand's own next step down is warm rather than grey (--oat-deep, in
   product-blocks), but that is NOT a token themeToCssVars emits, and a literal
   hex here would put one tenant's cream on every tenant's page — the §158
   fault again.

   So: no fill. The colophon sits on the panel's own ground, which is the colour
   the mini app's slab was reaching for anyway. It is still unmistakably a
   sign-off — the character, the house line in the brand serif, the name between
   two hairlines — and it no longer wears a rectangle. The 60% ink of the meta
   line becomes var(--olive) by the rule already stated; the 30% ink of the two
   rules becomes rgba(0,0,0,.3), close enough to 30% ink in any palette a tenant
   can set.

   WITH NO FILL THERE IS NOTHING TO BLEED, so the -14px/+14px pair that pushed
   the old slab out through .sheet-b's padding and pulled its words back is
   gone too. The column lines up with the blocks above it by simply staying in
   the column. */
.pb-colo{margin:calc(29 * var(--u)) 0 0;padding:calc(37 * var(--u)) 0 calc(29 * var(--u));
  text-align:center;display:flex;flex-direction:column;
  align-items:center;gap:calc(15 * var(--u))}
.pb-colo-ch{width:calc(125 * var(--u));height:calc(125 * var(--u))}
/* mix-blend-mode DROPS THE WHITE SQUARE off the b-and-w line art, which is the
   component's own trick and the reason the character sits ON the page rather
   than in a box of its own. It is what makes a no-fill colophon possible at
   all: the files under public/brand/ are JPEGs on a pure white square, and
   multiply turns that square into whatever it is standing on.
   object-fit:contain keeps a non-square file whole. */
.pb-colo-ch img{width:100%;height:100%;object-fit:contain;display:block;
  mix-blend-mode:multiply}
.pb-colo-t{font-family:var(--f-bear);font-size:calc(23 * var(--u));line-height:1;
  letter-spacing:-.005em;overflow-wrap:anywhere}
.pb-colo-m{display:flex;align-items:center;justify-content:center;gap:calc(10 * var(--u));
  font-family:var(--f-bear);font-size:calc(10 * var(--u));letter-spacing:.32em;
  text-transform:uppercase;color:var(--olive);overflow-wrap:anywhere}
.pb-colo-r{flex:none;display:block;width:calc(23 * var(--u));height:1px;
  background:rgba(0,0,0,.3)}
/* THE KICKER WEARS A SHORT RULE, which is the mini app's own .pb-hero-kicker:
   a 19px bar in --forest before the words, with the words themselves in that
   same forest rather than the olive every other kicker on this page uses. It
   is the one kicker that introduces a paragraph rather than labelling a list,
   and the component distinguishes them exactly this way. */
.dt-pk{display:flex;align-items:center;gap:calc(10 * var(--u));font-family:var(--f-bear);
  font-size:calc(9.5 * var(--u));line-height:calc(12 * var(--u));letter-spacing:.17em;text-transform:uppercase;
  color:var(--forest);margin-bottom:calc(8 * var(--u))}
.dt-pk::before{content:"";flex:none;display:block;width:calc(19 * var(--u));height:calc(1 * var(--u));
  background:var(--forest)}
/* white-space:pre-line IS LOAD-BEARING AND WAS MISSING. The office writes the
   paragraph with blank lines in it and the editor honours them; without this
   every paragraph of a description ran together into one block on the live
   page, which is what a customer was reading. The component's .pb-hero-body
   has carried it all along. */
.dt-pb{font-size:calc(14 * var(--u));line-height:calc(22 * var(--u));overflow-wrap:anywhere;white-space:pre-line}
/* The inline ink-pull: one phrase mid-paragraph, set in the display face on a
   lime slab. box-decoration-break:clone is what keeps the slab's padding on
   BOTH halves when the phrase wraps across a line — without it the second line
   loses its left padding and the slab reads as torn. */
.pb-hl{font-family:var(--f-bear);font-style:normal;font-size:calc(17.5 * var(--u));line-height:1;
  letter-spacing:-.005em;background:var(--lime);color:var(--ink);
  padding:.06em .18em;
  -webkit-box-decoration-break:clone;box-decoration-break:clone}

/* The sizes' own add buttons. Never seen, never reachable by a thumb; the size
   picker clicks them so that §120's single add path stays single. */
.vadds{display:none}
/* line-height IS STATED, AND IN PIXELS. Left to its normal value this kicker
   computes 13.766px, and every box under it — the chip cloud, the allergen card, each
   chip — then starts on a fraction of a pixel and its text rasterises half
   blurred. It survived until §129 only because the fraction happened to land
   somewhere the measurement tolerated; the page changed what is above it and
   the same chip went 0.875px off the middle of its pill against a 0.75px
   allowance. Whole numbers here and on .ichip make the whole column integral. */
.dt-k{font-family:var(--f-bear);font-size:calc(9.5 * var(--u));line-height:calc(14 * var(--u));letter-spacing:.17em;
  text-transform:uppercase;color:var(--olive);margin:calc(18 * var(--u)) 0 calc(7 * var(--u))}

/* THE INGREDIENT CLOUD — the mini app's ingredients_chips, in this page's ink.
   The hero ingredient is FILLED and the rest outlined, which is the one thing
   the block's lead flag carries and the reason it exists: a customer reads
   what the product is mostly made of before reading the list.

   THE GAP AND THE PADDING ARE THE COMPONENT'S, AND THEY WERE NOT.
   Converted at this page's own rpx x .52, the component's chip is 16rpx of gap
   and 18rpx by 26rpx of padding: 8.3u, 9.4u, 13.5u. This page had 6u, 5u and
   11u — about a third under, on every axis at once — so a salad carrying eleven
   ingredients drew five rows of chips with six pixels between them and read as
   one solid block. Reported by Ash from a phone against the Quinoa Salad.
   WHOLE NUMBERS, not the converted decimals: .dt-k above records what a
   fractional box costs this column, and 8 / 7 / 13 are within a pixel of the
   component while keeping every chip on an integer. The padding stays
   symmetrical top and bottom, which is what the render suite measures — it
   checks where the chip's INK sits inside its pill, and that is unmoved. */
.ichips{display:flex;flex-wrap:wrap;gap:calc(8 * var(--u))}
.ichip{border:1.5px solid var(--ink);border-radius:999px;padding:calc(7 * var(--u)) calc(13 * var(--u));
  font-size:calc(12.5 * var(--u));line-height:calc(17 * var(--u))}
.ichip.lead{background:var(--ink);color:var(--oat);border-color:var(--ink)}
.ichip .pct{font-variant-numeric:tabular-nums;opacity:.7;font-size:calc(11 * var(--u))}

/* THE ALLERGEN CARD — contains and may-contain as separate rows, never merged.
   One says what is in the food; the other says what the line it was made on
   also handles, and somebody avoiding an allergen needs to know which is
   which. The two chip styles differ for the same reason. */
.acard{border:1px solid var(--ink);padding:calc(12 * var(--u));margin-top:calc(18 * var(--u))}
.atitle{font-family:var(--f-bear);font-size:calc(16 * var(--u));line-height:1;
  padding-bottom:calc(9 * var(--u));border-bottom:2px solid var(--ink);margin-bottom:calc(10 * var(--u))}
/* THE LABEL SITS ABOVE ITS CHIPS, AND BOTH CENTRE ON THE CARD. Centring them
   beside a fixed 96px label only centred them in what the label left over, so
   a short label like CONTAINS pushed its chip well right of the card's middle
   and it still read as misplaced — the second report of the same thing. With
   the label on its own line there is no leftover column to be centred in: the
   chips have the card's full width and the card's own middle. It also ends the
   collision this card was always one long chip away from. */
.arow{display:flex;flex-direction:column;align-items:center;gap:calc(6 * var(--u));padding:calc(8 * var(--u)) 0}
.arow+.arow{border-top:1px dashed rgba(0,0,0,.14)}
/* 9.5px at 1.35 is 12.825px, and the chips under it then start on a fraction
   of a pixel — the last box in this column that was not a whole number. See
   .dt-k for what that costs and how it was measured. */
.alab{flex:none;max-width:100%;text-align:center;font-family:var(--f-bear);
  font-size:calc(9.5 * var(--u));letter-spacing:.1em;text-transform:uppercase;color:var(--olive);
  line-height:calc(13 * var(--u))}
.achips{width:100%;min-width:0;display:flex;flex-wrap:wrap;justify-content:center;gap:calc(5 * var(--u))}
/* Class selectors rather than a child combinator: no angle bracket may appear
   in this stylesheet, and the combinator's own character is one — the rule is
   stated at the head of the file and this is where its cost is paid. Naming it
   here in the obvious way tripped the same check a second time, which is the
   rule being blunt on purpose rather than misfiring. display:contents
   makes the two language wrappers vanish from layout so the chips are the
   flex items, rather than two blocks each holding a row. */
/* A CLASS OF ITS OWN, NOT .achips .l-cn — and that is the whole point of this
   rule rather than a tidiness preference. The language switch — the rule above
   that hides .l-cn under .lang-en — has specificity (0,2,0). A rule written as
   .achips .l-cn is ALSO (0,2,0), and this sheet is written later, so it WON and
   both languages rendered inside the allergen card: an English customer read
   "Gluten (oats)" followed by "麸质（燕麦）". Reported from a phone.
   .chipset is (0,1,0), so the switch beats it and the wrapper still collapses
   out of the flex row. */
.chipset{display:contents}
/* line-height:normal, WHICH IS THE FONT'S OWN, and it is measured rather than
   chosen. This pill draws its own background, so the space above the text and
   the space below it are both visible and any difference between them reads as
   the text sitting off. Ink measured at 4x, filled chip, both languages:

     1.3 (was)  English 0.1px high, Chinese 0.9px high
     1.15       English 1.1px high, Chinese 1.9px high
     1          English 1.1px high, Chinese 1.9px high
     normal     English 0.4px low,  Chinese 0.1px low

   The Chinese half is what moves, because a CJK glyph fills its em box top to
   bottom while a Latin one leaves the descender space empty — so a line-height
   chosen to look right in English rides the Chinese up. normal is the only one
   of the four that is under half a pixel out in both.
   NOT the same answer as the count chip, which wanted line-height:1: that box
   has a FIXED 24px height and the line box had to stop disagreeing with it.
   Here the pill takes its height FROM the line box, so the font's own figure is
   the one that balances. */
.achip{border-radius:999px;padding:calc(4 * var(--u)) calc(10 * var(--u));font-size:calc(11.5 * var(--u));line-height:normal;
  font-family:var(--f-bear);letter-spacing:.03em}
/* A FULL-WIDTH CLOSING BRACKET RESERVES A WHOLE CHARACTER BOX AND DRAWS ITS INK
   IN THE LEFT HALF OF IT. So a chip reading 麸质（燕麦） carries about two thirds
   of a character of blank at its right end, its text sits nearly 4px left of
   the pill it is in, and once the row is centred that is exactly what the eye
   catches — reported from a phone as still not centred after the row itself had
   been. Measured from the pixels: the ink, not the box, is what was off.
   Trimming the padding by that reserved half is the only thing that moves it,
   and it is what a Chinese typesetter does by hand. 'palt' and
   font-variant-east-asian:proportional-width were both tried first and neither
   does anything here — the bracket comes from the phone's own CJK fallback
   face, which implements neither.
   Two thirds of an em rather than a half: half leaves a pixel, three quarters
   overshoots, and the measurement says .67 lands it dead centre. */
.achip.tr{padding-right:calc(10 * var(--u) - .67em)}
.achip.tl{padding-left:calc(10 * var(--u) - .67em)}
/* CONTAINS reads louder than MAY CONTAIN, and neither borrows the page's lime:
   lime is this menu's "yes, add it" colour and an allergen is not that. */
.achip.has{background:var(--ink);color:var(--oat)}
.achip.may{background:transparent;color:var(--olive);border:1.5px dashed var(--olive)}
.anone{font-size:calc(12 * var(--u));color:var(--olive);font-style:italic}

/* .nut-card from miniapp/pages/product/product.wxss, converted at the same
   390px phone (rpx x .52) the rest of this file uses.
   EVERY FONT SIZE IN THIS CARD IS ALSO x1.15, AND THE PADDINGS ARE NOT. That
   is not a nicety: the app declares --font-scale: 1.15 in app.wxss and this is
   the one card whose source writes its sizes as calc(Nrpx * var(--font-scale))
   rather than as bare rpx. The first conversion applied .52 alone and dropped
   the scale, so the whole nutrition panel stood 13% smaller than the same panel
   in the mini app while every block above it matched. The scale multiplies font
   sizes only -- app.wxss says so -- so the borders, the padding and the indent
   stay at plain rpx x .52. */
.nut{border:1px solid var(--ink);padding:calc(14.5 * var(--u)) calc(14.5 * var(--u)) calc(9 * var(--u));margin-top:calc(14 * var(--u))}
.nut-top{display:flex;justify-content:space-between;align-items:flex-end;
  padding-bottom:calc(9 * var(--u));margin-bottom:calc(4 * var(--u));border-bottom:2px solid var(--ink)}
.nut-ttl{font-family:var(--f-bear);font-size:calc(23.9 * var(--u));line-height:1}
.nut-bs{font-style:italic;font-size:calc(13.1 * var(--u));color:rgba(0,0,0,.6);
  text-align:right;line-height:1.3}
.nr{display:flex;justify-content:space-between;align-items:baseline;gap:calc(10 * var(--u));
  padding:calc(8.3 * var(--u)) 0;border-bottom:1px solid rgba(0,0,0,.12)}
.nr:last-child{border-bottom:0}
.nr-l{font-family:var(--f-bear);font-size:calc(16.1 * var(--u));letter-spacing:.01em;
  text-transform:uppercase}
.nr-r{font-family:var(--f-bear);font-size:calc(23.9 * var(--u));line-height:1;
  font-variant-numeric:tabular-nums;white-space:nowrap}
.nr.p .nr-l{font-weight:600}
.nr.c{padding:calc(5.2 * var(--u)) 0 calc(5.2 * var(--u)) calc(23 * var(--u));border-bottom:1px dashed rgba(0,0,0,.12)}
.nr.c .nr-l{font-family:var(--f-aleo);font-style:italic;font-size:calc(15 * var(--u));
  color:rgba(0,0,0,.6);text-transform:none;letter-spacing:0}
.nr.c .nr-l::before{content:'—';margin-right:calc(6 * var(--u));color:rgba(0,0,0,.3);font-style:normal}
.nr.c .nr-r{font-size:calc(19.1 * var(--u));color:rgba(0,0,0,.6)}

/* The enlarge. A plain full-screen ground with the photo centred — no chrome,
   because the only thing to do here is look and then dismiss. */
.big{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.92);
  display:flex;align-items:center;justify-content:center;padding:16px;cursor:zoom-out}
.big[hidden]{display:none}
.big img{max-width:100%;max-height:100%;object-fit:contain}
/* Top-right, clear of the phone's own status bar and of the notch inset. The
   16px is THE OVERLAY'S OWN PADDING, above, so the button's outer edge lines up
   with the photo's rather than sitting at an inset of its own choosing — at
   10px it hugged the corner and read as stuck to it. Oat rather than white:
   this is the one control on the screen and it wears the house's off-white
   like every other border on the page. */
.big-x{position:absolute;top:calc(16px + env(safe-area-inset-top));right:16px;
  width:44px;height:44px;border:2px solid var(--oat);background:rgba(0,0,0,.55);
  color:var(--oat);padding:0;cursor:pointer;
  -webkit-tap-highlight-color:transparent}

/* ── the basket ── */
/* The add button sits on the photo's own corner rather than under the name,
   because the photo is the biggest tap target on the card and the thumb is
   already there. Square, ink-bordered, lime — the same three moves the rest of
   this page makes, so it reads as part of the shop rather than as a widget. */
/* The price row: price on the left, add on the right, baselines apart because
   the button is a box and the price is type. A sold-out card has no button, so
   the row is the price alone and needs no separate rule. */
/* min-height MATCHES THE BUTTON, so a card that has no button — a sold-out one —
   still reserves the same row and its price sits at the same level as its
   neighbour's. Without it the row collapses to the height of the price alone
   and that price rides high by half the difference, which reads as a wobble
   rather than as anything deliberate. */
/* .sl-cfoot, plus one deliberate DEPARTURE: min-height. The website's foot has
   none, so a card with no + — a sold-out one — collapses to the height of its
   price and that price rides high beside its neighbour's. Reported from a phone
   and fixed here rather than copied faithfully. */
.pf{display:flex;align-items:center;justify-content:space-between;gap:8px;
  margin-top:auto;padding-top:5px;min-height:26px}
/* THE MINI APP'S OWN ADD CHIP, AT ITS OWN SIZE. Taken from .card-plus in
   miniapp/pages/shop/shop.wxss — 52rpx square with a 26x5rpx bar — converted at
   the same 390px phone the rest of this file's values were converted at
   (390/750), which is 27px and 13.5x2.6px. It was 36px first and read as
   overbearing beside the price; the number was guessed then and is measured
   now.
   THE + IS TWO BARS, NOT A GLYPH, and that is borrowed with its reason rather
   than reinvented: the wxss records that the brand serif's "+" sat off-centre
   in the square and that no flex-centring could fix it, because centring aligns
   the text line box and not the ink inside it. This page uses the same serif,
   so it had the same bug — the first version of this button centred a glyph. */
.add{flex:none;position:relative;width:26px;height:26px;
  border:0;background:var(--ink);color:var(--lime);
  font-size:0;line-height:1;cursor:pointer;
  padding:0;-webkit-tap-highlight-color:transparent}
.add::before,.add::after{content:'';position:absolute;top:50%;left:50%;
  background:currentColor;transform:translate(-50%,-50%)}
.add::before{width:13px;height:2.5px}
.add::after{width:2.5px;height:13px}
.add:active{transform:translateY(1px)}

/* The bar clears the phone's home indicator; without the inset the tap target
   sits under it on every iPhone since the X. */
.cbar{position:fixed;left:0;right:0;bottom:0;z-index:30;
  padding:10px 12px calc(10px + env(safe-area-inset-bottom))}
.cbar[hidden]{display:none}
.cbar-b{width:100%;display:flex;align-items:center;gap:10px;
  border:2px solid var(--ink);background:var(--lime);color:var(--ink);
  padding:12px 14px;font:inherit;font-family:var(--f-bear);font-size:15px;
  cursor:pointer;-webkit-tap-highlight-color:transparent}
/* line-height:1 IS THE CENTRING, not a nicety. The chip inherited the body's
   1.45 — a line-height meant for reading paragraphs — so its line box was
   18.85px tall inside a 24px square, and the digit rode a full pixel above the
   middle of the black. Measured from the pixels, not from the box: on this page
   the digits come from the substitute face (a display face whose numerals stand
   in for the display face's own), so the line box was being sized by one font's
   metrics while the glyph in it belonged to another. */
.cbar-n{flex:none;min-width:24px;height:24px;display:flex;align-items:center;
  justify-content:center;background:var(--ink);color:var(--oat);
  font-size:13px;line-height:1}
.cbar-l{flex:1;text-align:left;letter-spacing:.04em}
.cbar-v{flex:none;font-variant-numeric:tabular-nums}

/* ── the menu does not move behind a sheet ──
   REPORTED BY ASH 2026-09-15, with a product sheet open over the menu:
   *"i can scroll the menu itself behind the pop up ... scrolling of the menu
   should be block if there is a pop up product info."* There was no lock of
   any kind. shOpen and shClose only ever toggled [hidden] and the animation
   class, so every sheet this page has — the product details, the basket, the
   picker, the placed order — has been a panel laid over a page that still
   scrolled under the thumb.

   THE LOCK IS overflow ON THE ROOT, NOT position:fixed ON THE BODY. The
   fixed-body trick is the one usually reached for and it is wrong here: it
   takes the document out of flow, which drops the scroll offset to the top of
   the page, and this page has a STICKY header that would visibly jump away
   the instant a customer tapped a card. Setting overflow on the root keeps
   the offset and moves nothing; scripts/test_shop_menu_render.js measures
   exactly that, because a lock that scrolls the page to the top on open would
   be a worse bug than the one it fixes.

   .sh-lock IS ADDED WITH classList AND NEVER BY ASSIGNING className. The root
   element also carries .lang-en / .lang-cn, which is the switch the whole
   bilingual page hangs off; overwriting it here would show both languages at
   once on every sheet. */
html.sh-lock,html.sh-lock body{overflow:hidden;overscroll-behavior:none}
.sheet{position:fixed;inset:0;z-index:40;display:flex;align-items:flex-end}
.sheet[hidden]{display:none}
/* THE SCRIM EATS THE TOUCH. touch-action:none is what stops a finger dragged
   across the dimmed menu from scrolling it: the overflow lock below is what
   browsers obey, and this is what iOS obeys. Both, because this page is opened
   inside WeChat on both platforms and they fail differently. */
.sheet-bg{position:absolute;inset:0;background:rgba(0,0,0,.42);touch-action:none}
.sheet-p{position:relative;width:100%;max-height:86vh;max-height:86dvh;
  display:flex;flex-direction:column;background:var(--oat);
  border-top:2px solid var(--ink)}

/* IT SLIDES UP RATHER THAN APPEARING. A panel that arrives with no movement
   reads as the page having jumped; the travel is what tells a customer this
   came from the bottom and goes back there. Keyframes rather than a transition,
   because the sheet opens by losing [hidden] — an element coming out of
   display:none has no previous value to transition FROM, and a transition
   would simply not play. Closing plays the same pair backwards, driven by a
   class the script adds and then removes.
   Deliberately short: 210ms out, 160ms back. This sits between a customer and
   their order, and an animation they wait for twice is a slower menu. The
   first pair, 180/140, read as a snap on a real phone and was slowed by 15%.
   THE 160 IS ALSO IN shClose's timer — the panel is only [hidden] once the
   travel has played, so the two numbers are one number and must move together. */
@keyframes shIn{from{transform:translateY(100%)}to{transform:none}}
@keyframes shOut{from{transform:none}to{transform:translateY(100%)}}
@keyframes bgIn{from{opacity:0}to{opacity:1}}
@keyframes bgOut{from{opacity:1}to{opacity:0}}
.sheet:not([hidden]) .sheet-p{animation:shIn .21s cubic-bezier(.22,.7,.3,1) both}
.sheet:not([hidden]) .sheet-bg{animation:bgIn .21s ease both}
.sheet.closing .sheet-p{animation:shOut .16s cubic-bezier(.5,0,.8,.4) both}
.sheet.closing .sheet-bg{animation:bgOut .16s ease both}
.big:not([hidden]){animation:bgIn .16s ease both}
/* Somebody who has asked their phone to stop animating gets the panel with no
   travel at all — not a slower one. */
@media (prefers-reduced-motion:reduce){
  .sheet:not([hidden]) .sheet-p,.sheet:not([hidden]) .sheet-bg,
  .sheet.closing .sheet-p,.sheet.closing .sheet-bg,
  .big:not([hidden]){animation:none}
}
/* THE PRODUCT FLIES TO THE BASKET. A number changing at the bottom edge of a
   phone is easy to miss with a thumb over it; the flight is what says WHICH
   product went in and WHERE it went, before the customer has to look for the
   count. It is the mini app's own feedback, so somebody who knows the app is
   not learning a second language here.
   A CLONE OF THE CARD'S PHOTO, never the photo itself — moving the real one
   would leave a hole in the menu behind it, and put the card's own layout at
   the mercy of an animation. Fixed rather than absolute, so it does not care
   what the page is scrolled to, and pointer-events:none so a customer tapping
   a second product mid-flight is not blocked by the first one. */
.fly{position:fixed;z-index:70;pointer-events:none;opacity:1;
  background:var(--oat) center center no-repeat;background-size:cover;
  transition:transform .5s cubic-bezier(.35,.05,.3,1),opacity .5s ease-in}
/* Reduced motion gets the count and nothing thrown across the screen. */
@media (prefers-reduced-motion:reduce){.fly{display:none}}

.sheet-h{flex:none;display:flex;align-items:center;gap:10px;padding:12px 14px;
  border-bottom:2px solid var(--ink)}
.sheet-t{flex:1;font-family:var(--f-bear);font-size:16px;letter-spacing:.04em}
/* THE HEADING IS TWO LINES WHEN THE PICKER IS WEARING IT: what the sheet is
   asking, and the product it is asking about. The basket has one face and one
   line; the picker has a title that is the same words every time ("Choose
   your options") and would be useless without the name under it. .sheet-ht
   carries the flex:1 the wrapper now needs — .sheet-t keeps its own for
   #dsheetT, which is still a direct child of its own header. */
.sheet-ht{flex:1;min-width:0}
.sheet-n{font-size:12.5px;color:var(--olive);margin-top:2px;
  overflow-wrap:anywhere}
.sheet-n[hidden]{display:none}
.sheet-x{flex:none;position:relative;width:32px;height:32px;
  border:2px solid var(--ink);background:transparent;color:var(--ink);
  cursor:pointer;padding:0}

/* THE X IS DRAWN, NOT TYPED, and that is the difference between centring a
   glyph and centring a mark. A character is placed by its font's metrics, not
   by its ink: the house display face hangs its multiplication sign high in the
   em box, so centring the line box in a 44px square still left the cross
   sitting above the middle of it, which is what a customer sees. Two bars
   crossed at 45 degrees have their centre where the maths puts it. Same reason
   the card's + is two bars rather than a plus sign.
   Real spans rather than ::before and ::after, so the suite can measure where
   the mark actually landed — a pseudo-element has no box to ask about, and an
   assertion that cannot see the ink is how this shipped off-centre. */
.xb{position:absolute;left:50%;top:50%;height:2px;background:currentColor}
.xb1{transform:rotate(45deg)}
.xb2{transform:rotate(-45deg)}
.sheet-x .xb{width:14px;margin-left:-7px;margin-top:-1px}
.big-x .xb{width:20px;margin-left:-10px;margin-top:-1px}
/* overscroll-behavior:contain STOPS THE CHAIN. Without it, scrolling a sheet
   that has reached its own end hands the gesture to the page underneath, so a
   customer reading to the bottom of an ingredient list finds the menu moving
   behind it. The sheet's own list still scrolls; only the handover is refused. */
.sheet-b{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:4px 14px;
  overscroll-behavior:contain}
.sheet-f{flex:none;padding:12px 14px calc(12px + env(safe-area-inset-bottom));
  border-top:2px solid var(--ink)}

/* THE NAME GETS ITS OWN LINE. Name, stepper and price on one row is three
   things competing for 362px, and the name wins because it is the widest — so
   a product called "Apple Pie Overnight Oats" pushed the price off the right
   edge of the phone and the customer could not read what they were paying.
   Stacked, the name can be as long as it likes in either language and the row
   beneath it is a fixed stepper and a fixed price with the whole width to sit
   in. The cost is about 30px per line, which the sheet scrolls. */
.ln{display:flex;flex-direction:column;gap:8px;padding:12px 0;
  border-bottom:1px solid rgba(0,0,0,.08)}
.ln-t{min-width:0;overflow-wrap:anywhere;font-size:14px}
/* WHAT WAS CHOSEN, under the name it was chosen for (§120). Quieter than the
   product and indented under it, because it is a qualifier on that line rather
   than a line of its own — the same relation the kitchen ticket prints it in
   (feie.js indents the option under the item's name). */
.ln-o{font-size:12px;opacity:.65;margin-top:3px;overflow-wrap:anywhere}
.ln-r{display:flex;align-items:center;justify-content:space-between;gap:10px}
.ln-p{flex:none;font-variant-numeric:tabular-nums;font-size:14px}
.qty{flex:none;display:flex;align-items:center;border:2px solid var(--ink)}
.qty button{width:30px;height:30px;border:0;background:transparent;color:var(--ink);
  font-family:var(--f-bear);font-size:16px;line-height:1;cursor:pointer;padding:0}
.qty span{min-width:26px;text-align:center;line-height:1;font-variant-numeric:tabular-nums;
  font-size:14px}

/* ── the picker (§120) ──
   One block per question, each a heading and its answers. It borrows the
   basket's own furniture rather than inventing any: the hairline between rows
   is .ln's, the ticked answer wears the ink ground the rail's current category
   wears, and the price delta sits in the tabular column every other number on
   this sheet sits in. A customer who has read the basket has already learned
   how to read this.

   THE ANSWERS ARE FULL-WIDTH ROWS, not chips. Chips were tried first and read
   well in English and badly in 中文, where two-character answers all come out
   the same width and a row of them becomes a puzzle; a row per answer also
   gives the sold-out ones somewhere to put their word without reflowing the
   others. The cost is vertical space, which the sheet scrolls. */
.og{padding:12px 0;border-bottom:1px solid rgba(0,0,0,.08)}
.og:last-child{border-bottom:0}
/* THE HEADING IS A KICKER, NOT A SENTENCE — uppercase, letterspaced, olive,
   in the display face. Same treatment .dt-k, .alab and .mo-h already wear on
   this page, and the same one .op-q wears in the mini app's own picker. The
   question is a label over its answers rather than a line of prose beside
   them, and at 12.5px it stops competing with the 16px answers below it. */
.og-q{font-family:var(--f-bear);font-size:12.5px;letter-spacing:.08em;
  text-transform:uppercase;color:var(--olive);margin-bottom:7px;
  overflow-wrap:anywhere}
/* HOW MANY THE QUESTION TAKES, under its heading. Not in the heading: the
   heading is a kicker in the display face and a numeral set in it reads as
   part of the question's name rather than as a rule about it. Quiet ink
   rather than olive, because it is the answer to a question nobody asked
   until they try to tick a third box — and loud at 12px would compete with
   the answers it is describing. Sits above the first .oc, which brings its
   own 7px, so this only has to close the gap the heading opened. */
.og-lim{font-size:12px;color:var(--ink);opacity:.62;margin:-3px 0 4px;
  overflow-wrap:anywhere}
/* THE REQUIRED MARKER IS AN ASTERISK, and it replaces a note that stood here
   saying there would be none. That note gave two grounds: there is no live
   English/中文 pair for the word "required", and the mini app's own picker
   marks nothing either. THE SECOND GROUND WAS SIMPLY WRONG — product.wxml has
   rendered is_required ? " *" : "" inside .op-q for as long as that sheet has
   existed, which is what this picker was asked to match. The first ground
   survives and is why the marker is a glyph: an asterisk is not a word, so it
   needs no pair and mints nothing. It sits OUTSIDE bi()'s two spans, because
   it is the same mark in both languages and because the suite reads the
   question out of .og-q .l-en and must keep reading the question alone.
   Rule 2B is untouched: Add still blocks and still names the question. */
.og-req{color:var(--olive)}
/* ROUNDED AND FILLED, matching the mini app's .op-choice row for row: a 7px
   corner, a 1.5px rule and a near-white card lifted off the oat ground, at
   the mini app's own 24rpx/28rpx padding converted at a 390px phone. The fill
   is this sheet's existing veil — the one .err and .pw button already use —
   rather than a second near-white literal invented for one control. */
.oc{display:flex;align-items:center;justify-content:space-between;gap:10px;
  width:100%;padding:12.5px 14px;margin-top:7px;cursor:pointer;
  border:1.5px solid var(--ink);border-radius:7px;
  background:rgba(255,255,255,.72);color:var(--ink);
  font-family:inherit;font-size:16px;text-align:left}
.oc-l{min-width:0;overflow-wrap:anywhere}
.oc-d{flex:none;font-variant-numeric:tabular-nums;font-size:12.5px;
  color:var(--olive)}
/* Ticked. The ground flips rather than a tick appearing beside the label:
   a checkbox glyph at this size is a smaller target than the row it marks. */
/* Ticked. The ground flips rather than a tick appearing beside the label:
   a checkbox glyph at this size is a smaller target than the row it marks.
   THE COLOUR IS --oat, AND THE ONE IT REPLACES WAS A BUG. This rule asked for
   var(--paper), which themeToCssVars has never emitted — the whole token set
   is --oat/--ink/--forest/--lime/--olive plus the two faces. An unresolvable
   var() makes the declaration invalid at computed-value time, which for an
   inherited property means inherit, so the ticked row inherited --ink and
   drew ink text on an ink ground: the answer a customer had just chosen was
   the one they could no longer read. --oat is the ground this sheet sits on
   and the pair .ichip.lead already uses against the same --ink. */
.oc.on{background:var(--ink);color:var(--oat)}
.oc.on .oc-d{color:var(--oat);opacity:.85}
/* Sold out. Not disabled-and-silent — the word is the whole point, and it
   takes the delta's column because a price nobody can pay is noise. */
.oc.out{cursor:not-allowed;opacity:.42}
.oc.out .oc-l{text-decoration:line-through}
/* AT THE CEILING. Dimmed like a sold-out answer and refusing taps for the
   same reason — it cannot be had right now — but WITHOUT the strike-through,
   because nothing is sold out and a line through the veggie sticks would say
   the kitchen has run out of them. The difference is temporary and the
   customer holds the remedy: unticking one of the two they already chose
   brings every row back. That is also why a TICKED row never gets this class
   — untick is the only way out, so the way out must stay tappable. */
.oc.cap{cursor:not-allowed;opacity:.42}
/* A PICK-ANY QUESTION SAYS SO, AND IT SAYS SO WITH A BOX ON EVERY ANSWER.
   Until 2026-09-15 this picker drew a single-answer question and a
   multi-answer one with identical furniture — a column of rows that flip to
   an ink ground — so nothing on the screen distinguished "pick one of these"
   from "pick any of these". REPORTED BY ASH, who ticked both breads on a
   product whose question is typed multi and read it as the picker being
   broken: *"it let me choose both options."* It was not broken, and that is
   exactly the problem — a control that is behaving correctly and looks
   identical to one that is not has failed at the only job the screen has.
   The mini app has never had this gap: .op-extra puts a tick box on every
   multi answer, which is the shape being copied here.
   THE BOX BORROWS currentColor RATHER THAN NAMING A TOKEN, so it flips with
   the row it sits in — an ink outline on the near-white ground, an oat
   outline and an oat tick once the row goes to ink. The mini app fills its
   box with --ink on a row that is already --ink, which leaves the box
   invisible and the tick floating; this reads the same and stays legible. */
.oc.multi{justify-content:flex-start;gap:12px}
.oc.multi .oc-l{flex:1}
.oc-x{flex:none;width:21px;height:21px;border:1.5px solid currentColor;
  border-radius:4px;display:flex;align-items:center;justify-content:center;
  font-size:14px;line-height:1}
/* The picker's foot holds one button and, when a required question has been
   left alone, one line above it. */
/* NO RULE ABOVE THE PICKER'S FOOT. .sheet-f draws one because the basket's
   foot is a form under a list of lines and needs separating from it; the
   picker's foot is one button under its own answers, and the mini app runs it
   as one unbroken panel. Scoped to this foot, so the basket keeps its rule. */
#sheetO{border-top:0}
#sheetO .err{margin-bottom:8px}
/* THE PICKER'S BUTTON IS INK, NOT LIME, and it is the one place on this page
   where those two part company. .place is lime everywhere else because it is
   the page's go: the button that ends the order. This one does not end
   anything — it puts a line in the basket and hands the customer back to the
   menu — and the mini app's .op-add has drawn that distinction in ink since
   its sheet shipped. Same 7px corner as the answers it sits under. */
#oAdd{background:var(--ink);color:var(--oat);border-radius:7px;
  letter-spacing:.06em}

/* ── the orders this phone has already placed ──
   One row per order: the number staff will call, the amount, and a chevron
   into that order's own page. The number wears the bar's own chip — same
   square, same ink ground, same 24px — because it is the same number, and a
   customer who has seen it in the bar should not have to work out that the one
   in this list is the same thing.
   A LINK, NOT A BUTTON, so it works with no script and reads as somewhere to
   go. It is placed at the FOOT of the basket, below every stepper, on purpose:
   the basket is memory only (§44) and a tap that navigates away loses it, so
   this must not sit anywhere a thumb reaching for a + or a − can find it. */
.mo-h{font-family:var(--f-bear);font-size:12px;line-height:1.2;letter-spacing:.04em;
  color:var(--olive);text-transform:uppercase;margin-top:18px;padding-bottom:2px}
.mo{display:flex;align-items:center;gap:10px;padding:12px 0;color:var(--ink);
  text-decoration:none;border-bottom:1px solid rgba(0,0,0,.08);
  -webkit-tap-highlight-color:transparent}
.mo-n{flex:none;min-width:24px;height:24px;display:flex;align-items:center;
  justify-content:center;background:var(--ink);color:var(--oat);
  font-family:var(--f-bear);font-size:13px;line-height:1}
.mo-l{flex:1;min-width:0;font-size:14px}
.mo-v{flex:none;font-variant-numeric:tabular-nums;font-size:14px}
.mo-c{flex:none;color:var(--olive);line-height:1}

.tot{display:flex;justify-content:space-between;align-items:center;gap:12px;
  font-family:var(--f-bear);font-size:17px;margin-bottom:10px}
.tot span:last-child{font-variant-numeric:tabular-nums}
/* THE PRODUCT SHEET'S OWN .tot: a price span beside .dadd, not two spans of
   text. .place's own width:100% put the button's flex-basis at the full row
   width, so it fought .dPr for space and the two ran together with no visible
   gap — reported from a phone as the price and the button touching. .dadd
   drops that width and shrinks to fit the row beside the price instead of
   filling it, so the tot's own gap actually shows between them. */
.tot .dadd{width:auto;margin-top:0;padding:11px 20px}
/* §129: WITH NO PRICE BESIDE IT, THE BUTTON TAKES THE ROW. A product with two
   sizes carries two prices, so the page shows neither and the button says
   CHOOSE A SIZE instead — which leaves it sitting alone against the left edge
   of a full-width bar, reading as a small control somebody forgot to stretch.
   flex rather than width:100%, because width:100% is the exact thing that
   caused the price and the button to touch in the first place (see above): it
   sets the flex-basis to the whole row and the gap collapses. This only ever
   applies when there is nothing to keep a gap from. */
.tot.solo .dadd{flex:1}
.nm-l{display:block;font-size:12px;line-height:1.2;letter-spacing:.04em;
  color:var(--olive);text-transform:uppercase;margin-bottom:6px}
.nm-i{width:100%;border:2px solid var(--ink);background:rgba(255,255,255,.72);
  padding:11px 12px;font:inherit;font-size:16px;color:var(--ink);
  border-radius:0;-webkit-appearance:none;appearance:none;
  -webkit-tap-highlight-color:transparent}
/* THE FOCUS RING IS OURS, NOT THE BROWSER'S. Left alone, the WeChat/Android
   web view paints its own amber ring on a focused field — reported from a phone
   as an orange frame that belongs to no design system here. It is drawn in the
   tenant's own ink instead, so the field reads as part of the shop in every
   browser, and outline-offset:-2px puts it over the border rather than outside
   it, so nothing shifts when the customer taps in.
   THE COMMENT ITSELF MUST NAME NO BRAND: this text is served inside the style
   element to every tenant, and §0's test greps the response for the seed
   tenant's name.
   Naming it here failed that check, which is the rule working on a comment. */
.nm-i:focus{outline:2px solid var(--ink);outline-offset:-2px}
/* 16px is not a style choice: iOS Safari zooms the whole page in on focus for
   anything smaller, and the customer lands zoomed into a menu they then have to
   pinch back out of. */
.place{width:100%;margin-top:10px;border:2px solid var(--ink);background:var(--lime);
  color:var(--ink);padding:13px;font:inherit;font-family:var(--f-bear);font-size:16px;
  cursor:pointer;-webkit-tap-highlight-color:transparent}
.place[disabled]{opacity:.55;cursor:default}
.err{margin-top:10px;padding:10px 12px;border:2px solid var(--ink);
  background:rgba(255,255,255,.72);font-size:14px}
.err[hidden]{display:none}

/* How they intend to pay, asked BEFORE the order is placed rather than after —
   §50 puts the kitchen ticket on payment for the in-page path and on submit for
   the counter, so the answer has to exist by the time the order does. The whole
   row is absent unless the Official Account is configured. */
.pw{display:flex;gap:8px;margin-top:10px}
.pw[hidden]{display:none}
.pw button{flex:1;border:2px solid var(--ink);background:rgba(255,255,255,.72);
  color:var(--ink);padding:11px 8px;font:inherit;font-family:var(--f-bear);font-size:14px;
  cursor:pointer;-webkit-tap-highlight-color:transparent}
.pw button.on{background:var(--lime)}

/* ── THE PLACED ORDER, WHEREVER IT IS DRAWN ──
   Three surfaces render this block and they are one screen: the sheet that
   opens the instant the order is submitted, the order page the customer comes
   back to, and §50's in-page WeChat screen. THE RULES ARE THEREFORE ON .done
   ITSELF, not on the page that hosts it — see the note at .ordp for what is
   still the page's own and why.
   The number is the biggest thing on the phone, because the whole of what
   happens next is somebody calling it across a room. It no longer sits alone
   in a centred column, though: .done-hd puts it beside the name and the order
   reference, and everything below shares that one left edge. */
.done{padding:22px 14px 26px;text-align:left}
.done-n{flex:none;font-family:var(--f-bear);font-size:76px;line-height:.82;
  font-variant-numeric:tabular-nums}
.done-nm{font-family:var(--f-bear);font-size:20px;line-height:1.1;overflow-wrap:anywhere}
.done-s{font-size:14px;color:var(--olive);margin-top:8px}

/* WHAT THEY ORDERED, and it is the basket's own row with the stepper taken
   out. Reported 2026-09-08 from a phone: a customer who had placed an order
   could see the number, the name and the amount, and nowhere at all what the
   amount was FOR. The basket that held the lines is memory only, and
   submitting empties it — so the one screen that could still answer "what did
   I order" never asked.
   THE ROWS COME BACK FROM retail_order_items, which has carried a bilingual
   name per line since the order was written. Nothing is composed for this: the
   customer reads the same product name they tapped on the menu.
   .ln, .ln-t, .ln-r and .ln-p ARE the basket's classes, but a placed line is
   laid out differently from one still in the basket and the difference is not
   an inconsistency — see .done-it .ln below. The basket stacks its name over
   its controls to make room for a stepper; a placed line has no stepper, so it
   reads as one row. Same classes, one rule apiece, keyed on .done-it.
   LEFT-ALIGNED, like the rest of .done: a column of names and prices cannot be
   read down a ragged centre. */
/* The quantity, where the stepper used to be. Olive and quiet, because on a
   placed order it states a fact rather than offering a control. */
.ln-q{flex:none;font-variant-numeric:tabular-nums;font-size:14px;color:var(--olive)}
/* Cancelling. Quiet by construction — it sits below the order number, is the
   smallest thing on the screen, and takes two taps. A customer who wants it
   finds it; one who does not never has it under their thumb.
   The disclosure IS the confirmation step, which is why there is no script on
   this page: see the route. (No angle brackets in this comment — it ships
   inside the stylesheet, and the suite refuses one that could close it.) */
.cx{margin-top:22px;text-align:center}
.cx summary{display:inline-block;cursor:pointer;font-size:13px;color:var(--olive);
  text-decoration:underline;text-underline-offset:3px;list-style:none}
.cx summary::-webkit-details-marker{display:none}
.cx-b{margin-top:12px;padding:14px;border:2px solid var(--ink);
  background:rgba(255,255,255,.72)}
.cx-q{font-family:var(--f-bear);font-size:15px}
.cx-s{font-size:13px;color:var(--olive);margin-top:6px}
.cx-go{margin-top:12px;width:100%;border:2px solid var(--ink);background:var(--oat);
  color:var(--ink);padding:11px;font:inherit;font-family:var(--f-bear);font-size:15px;
  cursor:pointer;-webkit-tap-highlight-color:transparent}
.done-o{font-size:12px;color:var(--olive);margin-top:4px;
  font-variant-numeric:tabular-nums}

/* THE WAY OFF THIS PAGE, and it is a box rather than a second underlined line.
   Reported 2026-09-08 from a phone: the order page had no exit at all, and
   inside a WeChat web view the only control on screen is the one that closes
   the whole thing. The cancel below it is an underlined olive link, and a
   BACK that looked the same would put "leave this page" and "destroy this
   order" in one visual register a thumb cannot tell apart — so this one is
   bordered, ink on oat, and the cancel stays an underlined olive link behind
   its own disclosure.
   THE ORDER OF THE TWO IS INVERTED ON THE ORDER PAGE as of the regroup below,
   and deliberately: Back is pinned to a rail at the foot of the screen, so the
   cancel now comes FIRST in reading order and Back last. What v4.157 was
   protecting is the register, which is unchanged, and the distance between the
   two, which is larger — the destructive control is further from the resting
   thumb than it was when it sat immediately under a centred Back. */
.bk{display:inline-block;margin-top:20px;border:2px solid var(--ink);
  background:var(--oat);color:var(--ink);text-decoration:none;
  padding:11px 22px;font-family:var(--f-bear);font-size:15px;
  -webkit-tap-highlight-color:transparent}
.bk .cv{color:var(--olive);margin-right:6px}

/* ── THE ORDER PAGE, REGROUPED ──────────────────────────────────────────
   Reported by Ash, 2026-09-08, from a phone: "right now its not great
   alignment and use of space on the screen."

   IT WAS SEVEN CENTRED THINGS AND A HOLE. Number, name, status, lines, total,
   order code and Back were centred one under another, so nothing on the screen
   had a rank except by type size; the item row spent a whole line putting a
   quantity at the far left and a price at the far right with three hundred
   pixels of nothing between them; the total floated in a box that lined up
   with neither; and the last 40% of the phone was bare oat with the only way
   out adrift in the middle of it.

   THE FIX IS GROUPING, NOT RESTYLING. Every colour, face, border and string
   below is already on this page. Three blocks, each with one left edge — who
   the order is for, what is in it, what it comes to — and a rail at the bottom
   that gives the page a floor.

   .ordp IS THE PAGE'S OWN FURNITURE AND NOTHING ELSE — the full-height column,
   the rail at the foot, the tone the status carries. Everything about the
   BLOCK itself lives on .done above, where all three surfaces that draw a
   placed order can reach it.
   IT DID NOT START THAT WAY, AND THE CORRECTION IS THE RECORD. v4.162 scoped
   the whole treatment here, leaving the done sheet and the WeChat screen on the
   old centred column with the old stacked rows — named at the time as a
   divergence that ought to be closed. It was reported from a phone the same
   day, against the done sheet, in the same words as the first report: "the
   quantity still not in the same line." One order drawn three ways is one
   screen, and a rule that only reaches one of them is half a rule. */
.ordp{display:flex;flex-direction:column;min-height:100vh}
/* dvh where it exists: on a phone 100vh is the chrome-less height, so the rail
   would sit below the fold until the address bar hid itself. WeChat's Chromium
   runs several versions behind, so vh stays as the floor and dvh is the
   improvement rather than the requirement. */
@supports (height:100dvh){.ordp{min-height:100dvh}}
.ordp .done{flex:1}

/* WHO THE ORDER IS FOR. The number keeps all 76px of it — the whole of what
   happens next is somebody calling it across a room — but it stops being the
   first of three centred lines and becomes the left edge everything below
   aligns to. The name and the order reference sit beside it, and the block
   closes with the same 2px rule the rest of the page is drawn in.
   THE ORDER CODE COMES UP HERE from below the total, where it was stranded
   between the amount and a button. It identifies the order, so it belongs with
   the rest of the order's identity rather than in the middle of the money. */
.done-hd{display:flex;align-items:flex-end;gap:14px;
  padding-bottom:16px;border-bottom:2px solid var(--ink)}
.done-who{flex:1;min-width:0;padding-bottom:4px}

/* THE STATUS IS A CHIP, not a third line of display type. It is the one thing
   on this screen that changes between visits, and a bordered box is how the
   rest of this page marks something that stands on its own.

   AND THE ACCENT NOW MEANS ONE THING. Lime is what the customer still has to
   act on. It was painted on the total in every state alike, so a CANCELLED
   order showed the same bright figure as one still waiting to be paid — the
   page telling somebody who owes nothing to walk to a till. The chip and the
   total now take their tone from one class on the wrapper, so the two can
   never disagree about whether money is owed:
     (none)  lime   still to hand over at the counter
     .paid   ink    settled — the ink chip the order list already wears
     .void   olive  cancelled: nothing owed, so nothing calls */
.done-h{display:inline-block;margin-top:16px;padding:7px 13px;
  border:2px solid var(--ink);background:var(--lime);
  font-family:var(--f-bear);font-size:15px;line-height:1.1}
/* #payOk IS the paid face — it is what the WeChat screen reveals when the
   charge lands — so it carries the settled tone by name. The order page
   keeps its tone on the wrapper because its .done element must stay exactly
   div class="done" and nothing else: three checks find the block by those
   bytes. */
.ordp.paid .done-h,#payOk .done-h{background:var(--ink);color:var(--oat);border-color:var(--ink)}
.ordp.void .done-h{background:transparent;color:var(--olive);border-color:var(--olive)}

/* ONE ROW PER LINE. The row this page borrows from the basket stacks the name
   over the quantity because a BASKET needs that width for a stepper; a placed
   order has no stepper, and the second line was carrying a quantity and a
   price at opposite edges of the phone with nothing in between.
   Name flexes, quantity and price travel together at the right edge, which is
   where a receipt puts them. A long name in either language still wraps inside
   its own column — .ln-t keeps the min-width:0 it is given above and the pair
   on the right is flex:none, so the price cannot be pushed off the edge. */
.done-it{text-align:left;margin-top:20px;border-top:1px solid rgba(0,0,0,.14)}
.done-it .ln{flex-direction:row;align-items:baseline;gap:12px;padding:11px 0;
  border-bottom:1px solid rgba(0,0,0,.14)}
.done-it .ln-t{flex:1}
.done-it .ln-r{flex:none;gap:10px}
.done-it .ln-p{min-width:62px;text-align:right}

/* THE TOTAL KEEPS ITS SIZE AND GAINS ITS EDGES AND A LABEL. Still the
   second-biggest thing on the phone and still boxed in the accent where money
   is owed — but it now spans the column it totals instead of floating in the
   middle of it, and it says what it is. On a one-line order the customer was
   shown the same figure twice with nothing telling them which was which.
   THE LABEL IS THE BASKET'S OWN PAIR, taken from the sheet footer this same
   file draws a hundred lines up. Nothing is composed: the figure quoted before
   they submitted and the figure they come back to are now the same labelled
   row, which is the whole reason for reusing it rather than minting a word. */
.done-amt{display:flex;align-items:baseline;justify-content:space-between;
  gap:12px;width:100%;margin-top:18px;padding:13px 16px 11px;
  font-family:var(--f-bear);font-size:34px;line-height:1;
  background:var(--lime);border:2px solid var(--ink);
  font-variant-numeric:tabular-nums}
.ordp.paid .done-amt,#payOk .done-amt{background:transparent}
.ordp.void .done-amt{background:transparent;border-color:var(--olive);color:var(--olive)}
.done-amt-l{font-size:15px;line-height:1}
/* The cap-trim above is written for a figure alone in its box. Here the box
   holds a label as well, so the trim moves onto the figure itself and the box
   goes back to symmetric padding. */
@supports (text-box: trim-both cap alphabetic){
  .done-amt{padding:14px 16px}
  .done-amt-v{text-box:trim-both cap alphabetic}
}

/* THE PAGE GETS A FLOOR. Back moves out of the middle of an empty half-screen
   into a rail at the bottom — flex:none, a 2px top rule, the safe-area padding
   — which is the rail the product sheet already ends with. The content above
   it can then be as short as a one-line order without the page appearing to
   simply run out.
   THE CANCEL DOES NOT COME WITH IT, AND THE GAP IS THE POINT. It stays up
   under the total, the smallest thing on the screen and behind its own
   disclosure; the band of oat between the two is what keeps the destructive
   control out of reach of the thumb resting on the safe one. */
.ord-f{flex:none;padding:12px 14px calc(12px + env(safe-area-inset-bottom));
  border-top:2px solid var(--ink);background:var(--oat)}
.ordp .bk{display:block;margin-top:0;text-align:center;padding:13px 22px}

/* Tapping a rail category jumps to its section, and the bar is sticky over the
   top of wherever that lands — so without this the heading the customer just
   asked for arrives hidden behind the header. Same measured height, same
   reason as the rail below. */
.cat{scroll-margin-top:calc(var(--barh) + 8px)}

/* ── the rail ── */
/* IT STICKS BELOW THE BAR, NOT UNDER IT. The bar is sticky at top:0 and paints
   a solid ground at z-index 20, so a rail that also sticks at top:0 pins its
   own first category behind the header and pushes its last one past the bottom
   of the screen — which reads, correctly, as "the menu scrolled". --barh is the
   bar's measured height; the 58px is the fallback for the first paint and for a
   browser that runs no script, and it is deliberately close rather than exact:
   being a few pixels out is invisible, being a whole header out is the bug.
   The bar's height is not a constant — it grows with the safe-area inset and
   again when a long shop name wraps to two lines, and the language toggle can
   change which name is showing — so it is measured rather than written down. */
.rail{position:sticky;top:var(--barh);flex:none;width:92px;
  height:calc(100vh - var(--barh));height:calc(100dvh - var(--barh));
  overflow-y:auto;-webkit-overflow-scrolling:touch;
  align-self:flex-start;background:var(--oat);border-right:2px solid var(--ink)}
.rail a{display:flex;align-items:center;gap:2px;padding:16px 5px;
  font-family:var(--f-bear);font-size:13px;line-height:1.15;color:var(--ink);
  text-align:center;text-decoration:none;text-transform:uppercase;
  border-bottom:1px solid rgba(0,0,0,.08)}
.rail a::before{content:'';flex:none;width:9px}
.rail a .lb{flex:1;min-width:0;overflow-wrap:anywhere}
.rail a .cv{flex:none;width:9px;color:var(--olive);font-size:13px;line-height:1}
.rail a.on{background:var(--lime)}
.rail a.on .cv{color:var(--ink)}

/* ── the menu ── */
/* The pane's floor clears the basket bar when there is one, so the last row of
   products is never sitting underneath it. --cbarh is 0 until the bar appears. */
.pane{flex:1;min-width:0;background:rgba(255,255,255,.62);
  padding-bottom:calc(30px + var(--cbarh) + env(safe-area-inset-bottom))}
.sec-h{display:flex;align-items:baseline;justify-content:space-between;gap:10px;
  padding:16px 14px 8px}
.kick{font-family:var(--f-bear);font-size:10.5px;letter-spacing:.2em;
  text-transform:uppercase;color:var(--olive);overflow-wrap:anywhere}
.cnt{font-family:var(--f-bear);font-size:18px;letter-spacing:.04em;color:var(--olive);
  font-variant-numeric:tabular-nums}
/* ── the product card: public/shop.html's .sl-* grid card, verbatim ──
   THE WEBSITE IS THE RIGHT SOURCE FOR THIS PAGE, not the mini app's wxss. Both
   are the same design by the same house, but the website's half is already
   expressed in CSS pixels for a browser, and this is a browser page — so the
   values are copied rather than converted from rpx at an assumed phone width,
   which is where two rounds of "it is too big" came from. .sl-grid.g2,
   .sl-card, .sl-ci, .cn, .sl-cfoot, .sl-pr, .sl-plus and .sl-coos are the
   rules below, one for one. */
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:12px 16px}
/* A COLUMN, SO THE PRICE ROW SITS AT THE BOTTOM OF THE CARD RATHER THAN UNDER
   THE NAME. Two products side by side rarely have names of the same height —
   "Almond Butter" against "Maple Cinnamon Almond Butter" — and with the row
   flowing straight after the name, the two prices and their add buttons landed
   at different heights and the row read as broken. The grid already stretches
   both cards to the taller one; this makes the name absorb that difference
   instead of the price. */
.it{min-width:0;display:flex;flex-direction:column}
.ph{position:relative;aspect-ratio:4/5;background:var(--oat);overflow:hidden}
.ph img{width:100%;height:100%;object-fit:cover}
/* .sl-coos — the veil is rgba(0,0,0,.75) there, not .78, and the type is 10px. */
.sold{position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,.75);color:#fff;
  font-family:var(--f-bear);font-size:10px;letter-spacing:.12em;text-transform:uppercase;
  text-align:center;padding:4px 0}
/* .sl-card .cn and .sl-pr, copied. The name was 15px then 14.6px and the price
   19px then 16.6px — guessed, then converted from rpx; these are the numbers
   the website actually ships to a browser. The foot pushes itself down with
   margin-top:auto, which is .sl-cfoot's own way of making the price row sit at
   the bottom of a card whose neighbour has a taller name. */
.t{font-family:var(--f-bear);font-size:14px;line-height:1.2;margin-top:9px;
  color:var(--ink);overflow-wrap:anywhere}
/* tabular-nums is this page's own and is kept: it stops the figures jittering
   as prices change down a column, which the mini app wants too — its
   .row-price-stack comment asks for exactly that, by a different means.
   SIZE IS THE ONE DEPARTURE FROM "the website is the right source" ABOVE,
   on Ash's direction: 16px (the website's own .sl-pr) still read as too big
   here next to the chunky Lilita-One digit substitute. 13.5px is the mini
   app's post-fix .card .price — 26rpx converted at this file's own 390/750
   phone-width ratio (the same ratio .add's 26x5rpx bars were converted at,
   above) — so the counter menu now matches the mini app's price size rather
   than the website's. */
.pr{font-family:var(--f-bear);font-size:13.5px;line-height:1;letter-spacing:.04em;
  color:var(--ink);font-variant-numeric:tabular-nums}
.out .ph img{filter:grayscale(.5);opacity:.72}
.out .t,.out .pr{opacity:.5}

.empty{padding:64px 24px;text-align:center}
.empty .t{font-family:var(--f-bear);font-size:22px;line-height:1.2;margin:0}
.empty .s{margin-top:8px;color:var(--olive);font-size:14px}`;
}

// The pre-paint language script. It runs in <head>, before the body is
// painted, so the page never flashes the wrong language on its way to the
// right one. Order: this session's toggle wins, then an explicit ?lang=, then
// the client's own language, then English. Session storage, not a cookie:
// §44 wants the choice to hold for the session and this page sets no cookies.
function langScript(hasParam) {
  return `(function(){var K='shop_menu_lang',l=null;` +
    `try{l=sessionStorage.getItem(K)}catch(e){/* private mode throws on storage; open in English */}` +
    `if(l!=='en'&&l!=='cn'){l=${hasParam ? 'null' : '((navigator.language||\'\').toLowerCase().indexOf(\'zh\')===0?\'cn\':null)'}}` +
    `if(l==='en'||l==='cn'){var d=document.documentElement;` +
    `d.className='lang-'+l;d.setAttribute('lang',l==='cn'?'zh-CN':'en')}})();`;
}

const TOGGLE_SCRIPT = `(function(){var K='shop_menu_lang';` +
  `document.addEventListener('click',function(e){` +
  `var b=e.target.closest?e.target.closest('[data-lang]'):null;if(!b)return;` +
  `var l=b.getAttribute('data-lang');if(l!=='en'&&l!=='cn')return;` +
  `try{sessionStorage.setItem(K,l)}catch(x){/* private mode throws; the toggle still works, it just will not persist */}` +
  /* classList, NOT className. Assigning the whole class attribute here wiped
     every OTHER class the root was carrying, and §129 gave it one that matters:
     .sh-lock, the scroll lock that stops the menu moving behind an open sheet.
     Switching language with the basket up would have silently unlocked the page
     underneath it. The lock's own code was careful about this in the other
     direction — it adds with classList precisely so it cannot clobber .lang-* —
     and this line was the same hazard pointing the other way. */
  `var d=document.documentElement;` +
  `d.classList.remove('lang-en','lang-cn');d.classList.add('lang-'+l);` +
  `d.setAttribute('lang',l==='cn'?'zh-CN':'en');` +
  `var n=document.querySelectorAll('[data-lang]');` +
  `for(var i=0;i<n.length;i++){var on=n[i].getAttribute('data-lang')===l;` +
  `if(on)n[i].className='on';else n[i].className=''}` +
  `},false)})();` +
  // The bar's real height, published as --barh so the rail can stick BELOW it
  // rather than behind it. Re-measured on resize, on rotation, and whenever the
  // bar itself changes box — the language toggle can swap a one-line shop name
  // for a two-line one, and the rail must move with it rather than a header
  // later.
  `(function(){var b=document.querySelector('.bar');if(!b)return;` +
  `var set=function(){document.documentElement.style.setProperty('--barh',b.offsetHeight+'px')};set();` +
  `if(window.ResizeObserver){new ResizeObserver(set).observe(b)}` +
  `window.addEventListener('resize',set,false);` +
  `window.addEventListener('orientationchange',set,false);})();` +
  // The rail follows the scroll. Progressive enhancement only: without it the
  // rail is still a working list of anchors, which is the whole of its job.
  `(function(){var r=document.querySelectorAll('.rail a[data-cat]');if(!r.length||!window.IntersectionObserver)return;` +
  `var m={};for(var i=0;i<r.length;i++)m[r[i].getAttribute('data-cat')]=r[i];` +
  `var o=new IntersectionObserver(function(es){for(var i=0;i<es.length;i++){if(!es[i].isIntersecting)continue;` +
  `for(var k in m)m[k].className='';var a=m[es[i].target.id];if(a)a.className='on'}},{rootMargin:'-45% 0px -50% 0px'});` +
  `var c=document.querySelectorAll('.cat');for(var j=0;j<c.length;j++)o.observe(c[j]);})();` +

  // ── OPENING AND CLOSING A PANEL ─────────────────────────────────────────
  //
  // SHARED BY BOTH SHEETS, because a basket that snaps shut beside a product
  // card that slides shut is the same jump reported on the way in, just later.
  // The class drives the keyframes; [hidden] is only set once they have played,
  // so the panel is never yanked out from under the travel. Any pending close
  // is cancelled on open — a customer who taps a second card while the first is
  // still on its way down must not have the new sheet hidden underneath them.
  //
  // Somebody who asked their phone to stop animating gets neither the travel
  // nor the wait: the panel is simply gone, which is what they asked for.
  `var shRM=function(){try{return window.matchMedia('(prefers-reduced-motion:reduce)').matches}` +
  `catch(x){return false}};` +
  /* IS ANY SHEET STILL UP? Asked of the DOM rather than kept in a counter,
     because a counter is a second source of truth for something the [hidden]
     attribute already says, and the two drift the first time a sheet is closed
     by a path that forgot to decrement. A sheet on its way out carries the
     'closing' class and does NOT count: the page is free to scroll again the
     moment the customer has dismissed it, not 160ms later. */
  `var shAnyUp=function(){var n=document.querySelectorAll('.sheet');` +
  `for(var i=0;i<n.length;i++){var e=n[i];` +
  `if(!e.hidden&&e.className.indexOf('closing')<0)return true}return false};` +
  /* classList, NOT className — the root carries the language switch. */
  `var shSync=function(){var r=document.documentElement;` +
  `if(shAnyUp())r.classList.add('sh-lock');else r.classList.remove('sh-lock')};` +
  `var shOpen=function(el){if(el.shT){clearTimeout(el.shT);el.shT=null}` +
  `el.className='sheet';el.hidden=false;shSync()};` +
  `var shClose=function(el){if(el.hidden)return;` +
  `if(el.shT){clearTimeout(el.shT);el.shT=null}` +
  `if(shRM()){el.hidden=true;el.className='sheet';shSync();return}` +
  `el.className='sheet closing';shSync();` +
  `el.shT=setTimeout(function(){el.shT=null;el.hidden=true;el.className='sheet'},160)};` +

  // ── THE PRODUCT SHEET ───────────────────────────────────────────────────
  //
  // The body is already rendered, server-side, into a <template> on each card,
  // so opening one is a move rather than a build: both languages are in it, the
  // CSS switch keeps working, and a customer on a slow connection waits for
  // nothing. That is the same reason the menu itself is server-rendered.
  `(function(){` +
  `var sh=document.getElementById('dsheet');if(!sh)return;` +
  `var body=document.getElementById('dsheetB'),ttl=document.getElementById('dsheetT'),` +
  `pr=document.getElementById('dPr'),add=document.getElementById('dAdd'),` +
  `addA=document.querySelector('#dAdd .dadd-a'),addS=document.querySelector('#dAdd .dadd-s'),` +
  `big=document.getElementById('big'),bigImg=document.getElementById('bigImg');` +
  `var openPid=null;` +
  /* §129 · THE PHONE'S BACK BUTTON CLOSES THE PAGE, and it is pushState that
     makes that possible without making it a navigation. §44 puts the basket in
     memory and nowhere else — no cookie, no storage — so a real page load for
     every product a customer looked at would empty their basket. pushState
     moves the history entry without reloading anything, so Back is wired to the
     gesture the customer already has and the basket survives.

     ONE ENTRY AT A TIME, tracked by `pushed`. Closing by the × pops the entry
     it pushed, so Back afterwards leaves the menu rather than re-opening the
     page the customer just dismissed; closing by Back has already popped it and
     must not pop a second time, which would walk them off the menu entirely.
     A browser that refuses pushState (file://, a locked-down web view) throws,
     and the page still opens and closes by its own × — the try is not
     decoration. */
  /* SCROLL RESTORATION IS TURNED OFF, and skipping this undoes the lock's own
     promise. The history entry the page pushes belongs to a menu that was
     scrolled somewhere; going back to it makes the browser restore the offset
     IT recorded for that entry, which is where the page was when it first
     loaded — the top. So closing a product would fire the customer back to the
     start of the menu they were half way down. Measured: the suite's own lock
     check caught it returning to 0. Setting it manual leaves the offset alone,
     which is what the whole overflow lock exists to do. */
  `try{if('scrollRestoration' in history)history.scrollRestoration='manual'}` +
  `catch(e){/* a web view that will not let this be set keeps its own restoration; the page still opens and closes, it may just put the menu back at the top */}` +
  `var pushed=false;` +
  `var close=function(fromPop){shClose(sh);openPid=null;` +
  `if(pushed){pushed=false;if(!fromPop){try{history.back()}` +
  `catch(e){/* a web view that refused the pushState above has nothing to go back to; the page is already closed, and the only cost is one dead history entry */}}}};` +
  `window.addEventListener('popstate',function(){if(!sh.hidden)close(true)},false);` +
  `var open=function(card){` +
  `var t=card.querySelector('template[data-dt]');if(!t)return;` +
  `openPid=card.getAttribute('data-open');` +
  // cloneNode rather than innerHTML: the template's content is already parsed,
  // and re-parsing a string is the step where an unescaped name would become
  // markup.
  `body.innerHTML='';body.appendChild(t.content.cloneNode(true));` +
  `var n=card.querySelector('.t');ttl.innerHTML=n?n.innerHTML:'';` +
  `var p=card.querySelector('.pr');pr.textContent=p?p.textContent:'';` +
  // A sold-out product still opens — a customer may want to know what was in
  // the thing they cannot have — but it cannot be added from here.
  `var out=card.className.indexOf('out')>=0;add.hidden=out;` +
  /* THE BUTTON SAYS WHAT THE TAP WILL DO, and for a product with sizes that is
     not "add" and carries no price — there are two. CHOOSE A SIZE, and the
     price line is emptied rather than showing one of them, which is the mini
     app's own arrangement (its add-btn takes a `no-price` modifier for exactly
     this case). Read off the card's own + , so the page and the grid cannot
     disagree about which kind of product this is. */
  `var vb=card.querySelector('.add[data-sizes]');` +
  `if(addA)addA.hidden=!!vb;if(addS)addS.hidden=!vb;` +
  `pr.hidden=!!vb;` +
  // classList, not className: the same lesson the language toggle had to learn.
  `if(add.parentElement)add.parentElement.classList.toggle('solo',!!vb);` +
  `if(!pushed){try{history.pushState({dt:1},'');pushed=true}` +
  `catch(e){pushed=false/* file:// and some locked-down web views refuse pushState; the page then opens and closes by its own close button, which is how it worked before Back was wired up */}}` +
  `shOpen(sh);body.scrollTop=0};` +
  `document.addEventListener('click',function(e){` +
  `var z=e.target.closest?e.target.closest('.dt-ph[data-big]'):null;` +
  `if(z){var pid=z.getAttribute('data-big'),v=z.getAttribute('data-v')||'';` +
  // The enlarge asks the SAME route for a wider render. It is a separate URL,
  // so it caches separately and the thumbnail on the menu is never re-fetched.
  // \\/ NOT \/ — this is inside a template literal, where \/ collapses to a bare
  // slash and the emitted JS reads `replace(//$/` , which is a line comment that
  // swallows the whole rest of the script. Cost the entire page's behaviour once.
  `bigImg.src=location.pathname.replace(/\\/$/,'')+'/i/'+pid+'?v='+encodeURIComponent(v)+'&w=${HERO_W}';` +
  `big.hidden=false;return}` +
  `var card=e.target.closest?e.target.closest('.it[data-open]'):null;` +
  // A tap on the card's own + adds; it must not also open the sheet behind it.
  `if(card&&!(e.target.closest&&e.target.closest('.add'))){open(card);return}` +
  `},false);` +
  // CLOSING THE ENLARGE IS BOUND TO THE ELEMENTS THEMSELVES, not delegated:
  // the button, and the overlay behind it for the tap-anywhere habit.
  `var shut=function(){big.hidden=true;bigImg.src=''};` +
  `document.getElementById('bigX').addEventListener('click',function(e){` +
  `e.stopPropagation();shut()},false);` +
  `big.addEventListener('click',shut,false);` +
  `document.getElementById('dsheetX').addEventListener('click',function(){close()},false);` +
  `document.getElementById('dsheetBg').addEventListener('click',function(){close()},false);` +
  `document.addEventListener('keydown',function(e){if(e.key!=='Escape')return;` +
  `if(!big.hidden){shut();return}close()},false);` +
  // Keyboard: a card is role=button and focusable, so it answers Enter/Space.
  `document.addEventListener('keydown',function(e){` +
  `if(e.key!=='Enter'&&e.key!==' ')return;` +
  `var card=e.target.closest?e.target.closest('.it[data-open]'):null;` +
  `if(card){e.preventDefault();open(card)}},false);` +
  // Adding from the sheet routes through the card's own + , so there is one
  // add path and the basket cannot learn a second way to be wrong.
  /* Adding from the page routes through the card's own + , so there is one
     add path and the basket cannot learn a second way to be wrong.
     §129: THE PAGE STAYS OPEN IF THAT TAP OPENED A SHEET. A product with sizes
     or questions has not been added yet — the picker is now over this page and
     closing the page under it would pull the product's own words out from
     behind the question being asked about them. Asked of the sheet afterwards
     rather than predicted from the attributes, for the same reason the size
     rows ask: a second reading of the same flag is a second chance to be wrong.
     The card's + for a sized product carries data-sizes and no data-add, so it
     is looked up by either. */
  `add.addEventListener('click',function(){if(!openPid)return;` +
  `var card=document.querySelector('.it[data-open=\"'+openPid+'\"]');` +
  `var b=card?card.querySelector('.pf .add'):null;` +
  `if(!b)b=document.querySelector('.add[data-add=\"'+openPid+'\"]');` +
  `if(b)b.click();` +
  `var os=document.getElementById('sheet');` +
  `if(!os||os.hidden)close()},false);` +
  `})();` +
  // ── THE BASKET ──────────────────────────────────────────────────────────
  //
  // IT IS THE ONLY STATE THIS PAGE HOLDS, and it holds it in a plain object
  // that dies with the tab. No cookie, no storage, no session (§44, and the
  // brief). A basket that survived a reload would be an old order waiting to be
  // submitted by somebody who had forgotten it.
  //
  // BOTH LANGUAGES GO INTO EVERY LINE IT DRAWS, exactly as the server-rendered
  // half does, and CSS decides which is visible. Rendering only the current
  // language would make the toggle stop working for anything added after load —
  // the one place where a client-side render silently breaks a §26 property the
  // rest of the page holds.
  `(function(){` +
  `var bar=document.getElementById('cbar');if(!bar)return;` +
  `var sheet=document.getElementById('sheet'),body=document.getElementById('sheetB'),` +
  `ttl=document.getElementById('sheetT'),` +
  `foot=document.getElementById('sheetF'),nEl=document.getElementById('cbarN'),` +
  `optFoot=document.getElementById('sheetO'),oAdd=document.getElementById('oAdd'),` +
  `oErr=document.getElementById('oErr'),nmEl=document.getElementById('sheetN'),` +
  `vEl=document.getElementById('cbarV'),tEl=document.getElementById('cTot'),` +
  `errEl=document.getElementById('cErr'),nameEl=document.getElementById('cName'),` +
  `place=document.getElementById('cPlace'),lEl=document.getElementById('cbarL');` +
  /* THE ORDER THIS PHONE ALREADY PLACED, so closing the sheet is not losing it.
     Reported 2026-09-08: a customer dismissed the sheet carrying their number
     by mistake and had no way back to it — the number, the amount and the order
     existed only on that screen.

     A RECEIPT, NOT AN IDENTITY, and that is why it does not reopen §44's "no
     login, no session, no cookie". Nothing here says who anybody is: it is the
     address of one order, written by the phone that placed it, readable only by
     that phone. The unguessable token was already the authority; this just
     stops the customer being the only copy of it.

     THE BASKET IS STILL NOT PERSISTED, and that rule is untouched. A basket
     that survived a reload would be a stale order waiting to be submitted by
     accident, which is the defect the comment below this one describes. A
     PLACED order is the opposite: it already exists, and forgetting it is the
     defect.

     Wrapped, because storage throws rather than returns null in a locked-down
     WeChat webview and in private mode. A phone that cannot remember simply
     gets the behaviour that shipped. */
  `var OKEY='tacet-shop-order:'+location.pathname.replace(/\\/+$/,'').split('/').pop();` +
  /* SEVERAL ORDERS, NOT ONE. It held a single order and the second one
     overwrote it — a customer who ordered a coffee and came back for a cake
     could no longer reach the coffee, or cancel it. Newest first, five deep:
     more than anybody orders at one counter in one day, and small enough that
     the list is read rather than scrolled.
     THE CAP IS A CAP ON WHAT IS REMEMBERED, NOT ON WHAT EXISTS. A sixth order
     is placed, printed and paid for exactly as it always was; the phone simply
     stops carrying the oldest address, which the counter still has. */
  `var MAXO=5;` +
  `var mine=[];` +
  `try{var _r=localStorage.getItem(OKEY);if(_r)mine=JSON.parse(_r)}catch(e){mine=[]}` +
  /* A RECEIPT WRITTEN BEFORE THIS COULD HOLD MORE THAN ONE IS A LIST OF ONE.
     The single-object shape shipped this morning, and a customer holding one in
     the middle of a trading day must not be handed an empty bar because the
     shape changed underneath them. */
  `if(!Array.isArray(mine))mine=(mine&&typeof mine==='object')?[mine]:[];` +
  /* AND IT FORGETS. Twelve hours, which is longer than any counter's day and
     shorter than the gap to the next one — so a customer who comes back
     tomorrow is not shown yesterday's number, and one who steps out for an
     hour still is. The number itself restarts at 1 each trading day
     (lib/shop-order-code.js), so a stale bar would not merely be old, it would
     name an order that belongs to somebody else today.
     Bounded here rather than by asking the server, because this runs on the
     first paint of a page whose whole point is that it renders in one
     response — a status fetch before the bar can be trusted would put a
     round trip in front of it. The order page states the truth when tapped. */
  /* Each entry carries its own stamp and is judged on it, so a morning order
     drops off while the one placed ten minutes ago stays. An entry missing its
     number, its stamp or its address is dropped as well — and the address is
     checked for SHAPE, not merely for presence: it is read back out of storage
     and put straight into an href, and the only thing this page ever writes
     there is one of its own order pages. */
  `var _keep=[],_now=Date.now();` +
  `for(var _i=0;_i<mine.length;_i++){var _o=mine[_i];` +
  `if(!_o||_o.n==null||!_o.ts)continue;` +
  `if(typeof _o.u!=='string'||_o.u.indexOf('/s/')!==0)continue;` +
  `if((_now-_o.ts)>43200000)continue;` +
  `if(_keep.length<MAXO)_keep.push(_o)}` +
  // Written back only when something actually went, so an ordinary visit does
  // not rewrite storage on every page load.
  `if(_keep.length!==mine.length){mine=_keep;` +
  `try{if(mine.length)localStorage.setItem(OKEY,JSON.stringify(mine));` +
  `else localStorage.removeItem(OKEY)}catch(e){/* storage refused; mine is already the pruned list in memory, which is the state this was writing */}}` +
  `else{mine=_keep}` +
  // { pid: {qty, price, en, cn} } — insertion order is the order the customer
  // chose, which is the order the basket lists and the order the kitchen reads.
  `var cart={},sending=false;` +
  `var esc=function(t){return String(t==null?'':t).replace(/[&<>"]/g,function(c){` +
  `return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})};` +
  `var bi=function(en,cn){return '<span class="l-en">'+esc(en)+'</span>'+` +
  `'<span class="l-cn">'+esc(cn)+'</span>'};` +
  // THE THREE LABELS THIS SCRIPT REPAINTS, built once at module load. Two are
  // already on this page; the third, My orders · 我的订单, is the web
  // storefront's own heading for this exact list (public/shop.html:3065, 3076,
  // 3443) — the customer reading their orders on the website and the one
  // reading them at the counter are the same person (§30). Nothing composed.
  `var L_ORD=${JSON.stringify(bi('Order', '订单号'))},` +
  `L_MINE=${JSON.stringify(bi('My orders', '我的订单'))},` +
  `L_BASKET=${JSON.stringify(bi('YOUR BASKET', '购物车'))};` +
  // §120's three, and all three are copied, not composed.
  //
  // Add to basket · 加入购物车 is the web storefront's own option-sheet button,
  // with its own separator and running price after it (public/shop.html's
  // priceLabel: `'加入购物车 · '` / `'Add to basket · '`) — the same control
  // doing the same job, so the customer who buys online meets the same words
  // standing at the counter (§30).
  //
  // Sold out · 售罄 is already on this page, on the card and in the submit
  // refusal; a dead answer inside the picker is the same fact one level down.
  //
  // Please choose: · 请选择 is the required-option refusal, live in BOTH the
  // storefront and the mini app, in both cases with the question's own text
  // appended exactly as it is appended here.
  `var L_ADD=${JSON.stringify(bi('Add to basket', '加入购物车'))},` +
  `L_OUT=${JSON.stringify(bi('Sold out', '售罄'))},` +
  `L_PICK_EN=${JSON.stringify('Please choose: ')},` +
  `L_PICK_CN=${JSON.stringify('请选择 ')},` +
  // §153's four customer pairs for HOW MANY a pick-any question takes, and
  // every one is COPIED rather than composed: public/shop.html builds these
  // exact four shapes in its own limHint(), and v1.99 of the vocabulary
  // document locked them there. The counter is 项 — the word 至少选一项
  // already established — and 款, from Ash's own 爽脆配菜（选2款） label, was
  // weighed and recorded as rejected when §153 declared them. Nothing new is
  // minted here and the document is not touched, because copying a locked
  // pair into the second page that needs it is not composing.
  //
  // They arrive in PIECES because the numeral is not known until the sheet
  // opens: the server clamps the floor against what is still pickable, so a
  // group authored as "choose 2" says "choose 1" when only one side is left.
  // A whole sentence baked at module load could not say that.
  `L_CH_EN=${JSON.stringify('Choose ')},L_CH_CN=${JSON.stringify('选 ')},` +
  `L_N_CN=${JSON.stringify(' 项')},` +
  `L_UPTO_EN=${JSON.stringify('Up to ')},L_UPTO_CN=${JSON.stringify('最多 ')},` +
  `L_ATL_EN=${JSON.stringify('At least ')},L_ATL_CN=${JSON.stringify('至少 ')},` +
  // The brackets the refusal puts round the count. Full-width in 中文, which
  // is what shop.html's own refusal uses and what the label that started this
  // — 爽脆配菜（选2款） — is already written with.
  `L_PO_EN=${JSON.stringify(' (')},L_PC_EN=${JSON.stringify(')')},` +
  `L_PO_CN=${JSON.stringify('（')},L_PC_CN=${JSON.stringify('）')},` +
  // THE PICKER'S HEADING, COPIED FROM A LIVE PAIR AND NOT COMPOSED. It is the
  // mini app's own, character for character: miniapp/pages/product/product.js
  // sets opTitle to '选择选项' / 'Choose your options' when its sheet opens.
  // The vocabulary document is not touched, for the same reason §120's
  // '请选择 ' above did not touch it — nothing here is new.
  `L_OPTS=${JSON.stringify(bi('Choose your options', '选择选项'))},` +
  // §129's two, and both are live pairs rather than compositions: the sheet
  // heading and the button label are miniapp/pages/product/product.js's own
  // ('选择规格' / 'Choose a size', and '选择规格' / 'CHOOSE A SIZE'), and
  // public/shop.html carries the identical pair for the same two controls.
  `L_SIZE=${JSON.stringify(bi('Choose a size', '选择规格'))};` +
  // THE TENANT'S CURRENCY, ALL THREE PARTS OF IT, read off the bar's own data
  // attributes rather than baked in here: this script is built once at module
  // load and the currency is resolved per request (§0 — no currency literal in
  // this file). Symbol, decimal places AND side, because a shop configured to
  // print "12.00€" or to use no decimals would otherwise get a basket total
  // formatted by different rules than the price on the card right above it.
  // This is money() from this same file, transcribed once.
  `var SYM=bar.getAttribute('data-sym')||'',` +
  `DEC=parseInt(bar.getAttribute('data-dec'),10),` +
  `AFTER=bar.getAttribute('data-pos')==='after';` +
  `if(!(DEC>=0))DEC=2;` +
  `var money=function(n){var v=(Number(n)||0).toFixed(DEC);return AFTER?(v+SYM):(SYM+v)};` +
  `var ids=function(){return Object.keys(cart)};` +
  `var count=function(){var n=0,k=ids();for(var i=0;i<k.length;i++)n+=cart[k[i]].qty;return n};` +
  `var total=function(){var t=0,k=ids();for(var i=0;i<k.length;i++)t+=cart[k[i]].qty*cart[k[i]].price;` +
  `return Math.round(t*100)/100};` +
  // ONE ROW PER ORDER THIS PHONE HAS PLACED, newest first — the number staff
  // call, what it cost, and the way into that order's own page, where the
  // status and the cancel live. Both languages in every row, like everything
  // else this script draws.
  `var ordRows=function(){var h='';` +
  `for(var i=0;i<mine.length;i++){var o=mine[i];` +
  `h+='<a class="mo" href="'+esc(o.u)+'">'+` +
  `'<span class="mo-n">'+esc(String(o.n))+'</span>'+` +
  `'<span class="mo-l">'+L_ORD+'</span>'+` +
  `'<span class="mo-v">'+esc(money(o.t))+'</span>'+` +
  `'<span class="mo-c">\\u203a</span></a>'}` +
  `return h};` +
  // THE LINES OF THE ORDER JUST PLACED, drawn from what the create response
  // already sends back. The server has returned `items` on every path since the
  // route was written and this screen simply dropped them — the customer was
  // handed the number, the name and the amount, and no account of what the
  // amount was for.
  //
  // THE SAME ROW THE SERVER DRAWS on the order page, and the same one the
  // basket above it draws: .ln with the stepper swapped for a plain quantity.
  // The done sheet and the page its bar links to are two views of one order and
  // must not disagree about how a line looks.
  //
  // money() IS THIS SCRIPT'S OWN, the one the basket and the bar already use,
  // so the line totals here round exactly as the ones the customer read before
  // submitting. A second formatter would be a price that changed at the till.
  `var lineRows=function(a){if(!a||!a.length)return '';var h='';` +
  `for(var i=0;i<a.length;i++){var it=a[i];` +
  `h+='<div class="ln"><div class="ln-t">'+bi(it.name_en,it.name_cn)+opsLine(it.options)+'</div>'+` +
  `'<div class="ln-r"><span class="ln-q">\u00d7'+esc(String(it.qty))+'</span>'+` +
  `'<div class="ln-p">'+money(it.line_total)+'</div></div></div>'}` +
  `return '<div class="done-it">'+h+'</div>'};` +
  // THE SHEET'S FOURTH FACE. The panel is the basket, the placed order and the
  // refusal — and now the list, which is the same furniture with the footer put
  // away and the header renamed. A second panel would have been a second thing
  // over the menu both of them exist to serve.
  `var openOrders=function(){pkClose();errEl.hidden=true;foot.hidden=true;` +
  `ttl.innerHTML=L_MINE;body.innerHTML=ordRows();shOpen(sheet)};` +
  // ONE BAR, TWO STATES. With something in the basket it is the basket. With
  // the basket empty and an order already placed from this phone, it is the way
  // back to that order — the number, what it cost, and a tap that opens the
  // order's own page. A second bar would have been a second permanent strip of
  // chrome over the menu both of them exist to serve.
  //
  // The label is the live pair the done screen already uses for this noun; the
  // number and the amount need no other word beside them.
  `var paintBar=function(){var n=count();` +
  `var back=(n===0&&mine.length>0);` +
  `bar.hidden=(n===0&&!back);` +
  // The floor under the menu follows the bar's real height rather than a guess,
  // the same measured-not-written-down rule the header uses.
  `document.documentElement.style.setProperty('--cbarh',(bar.hidden?0:bar.offsetHeight)+'px');` +
  // THE NEWEST ORDER IS THE ONE ON THE BAR. It is the number being called
  // next, and a bar that named the oldest would be a bar naming the order that
  // has already been collected. The rest are one tap away, in the sheet.
  `if(back){var m=mine[0];nEl.textContent=String(m.n);` +
  `lEl.innerHTML=L_ORD;` +
  `vEl.textContent=money(m.t);return}` +
  `lEl.innerHTML=L_BASKET;` +
  `nEl.textContent=String(n);vEl.textContent=money(total())};` +
  // The heading is set HERE rather than by whoever opened the panel, so the
  // face and the word above it are painted by one function and cannot drift
  // apart: anything that draws the basket says basket.
  `var paintSheet=function(){var k=ids(),h='';ttl.innerHTML=L_BASKET;` +
  `for(var i=0;i<k.length;i++){var it=cart[k[i]];` +
  `h+='<div class="ln"><div class="ln-t">'+bi(it.en,it.cn)+opsLine(it.ops)+'</div>'+` +
  `'<div class="ln-r"><div class="qty">'+` +
  `'<button type="button" data-d="'+esc(k[i])+'" aria-label="-">-</button>'+` +
  `'<span>'+it.qty+'</span>'+` +
  `'<button type="button" data-i="'+esc(k[i])+'" aria-label="+">+</button></div>'+` +
  `'<div class="ln-p">'+money(it.qty*it.price)+'</div></div></div>'}` +
  // AND UNDER THE BASKET, WHAT IS ALREADY ORDERED. With something in the
  // basket the bar is the basket, so this is the only place the earlier orders
  // are reachable while a second round is being built — the state where they
  // used to disappear. Below every stepper on purpose (see .mo in the CSS): a
  // tap here leaves the page and the basket is memory only.
  `if(mine.length)h+='<div class="mo-h">'+L_MINE+'</div>'+ordRows();` +
  `body.innerHTML=h;tEl.textContent=money(total())};` +
  `var closeIfEmpty=function(){if(count()===0){shClose(sheet)}};` +
  /* ── THE QUESTIONS THE COUNTER WOULD HAVE ASKED (§120) ──────────────────
     The answers a customer picked, printed under the product's name in the
     basket and again on the placed order. `Question: Answer`, never a bare
     answer: "Yes" under a latte says nothing, and the order page, the kitchen
     ticket and the till all already show the question beside it (feie.js's
     optLine does exactly this). Both languages in every half, like every other
     row this script draws — the CSS decides which is visible, not this code. */
  `var opsLine=function(a){if(!a||!a.length)return '';var h='';` +
  `for(var i=0;i<a.length;i++){var o=a[i];` +
  `h+='<div class="ln-o">'+bi(o.q_en+': '+o.en,o.q_cn+': '+o.cn)+'</div>'}` +
  `return h};` +
  /* THE BASKET IS KEYED BY WHAT WAS ORDERED, NOT BY WHICH PRODUCT. One
     full-sugar latte and one half-sugar latte are two lines, two prices and
     two things for the kitchen to make; keyed by product id alone the second
     tap would have silently become a second of the first. Sorted numerically
     so the same answers picked in a different order land on the same line. */
  `var ckey=function(pid,ch){return ch&&ch.length` +
  `?(pid+'|'+ch.slice().sort(function(a,b){return a-b}).join(','))` +
  `:String(pid)};` +
  /* The questions for one product, parsed once and remembered. They were
     rendered into the card's own <template> in the same response as the menu
     (see optJson), so opening a picker costs no round trip — the customer has
     just tapped and is standing up. */
  `var OPT={};` +
  `var optsFor=function(pid){if(OPT[pid]!==undefined)return OPT[pid];` +
  `var t=document.querySelector('template[data-op=\"'+pid+'\"]');` +
  `var v=null;` +
  `if(t){try{v=JSON.parse((t.content||t).textContent||'null')}catch(e){v=null}}` +
  `OPT[pid]=v;return v};` +
  /* WHAT THE PICKER IS CURRENTLY HOLDING. One product, its questions, and the
     answer ids ticked so far — a scalar-free model: every question keeps an
     ARRAY, and a single-answer question is simply one whose array is replaced
     rather than appended to. Two shapes for one idea is how a picker starts
     disagreeing with itself. */
  `var pk=null;` +
  /* Ticked answers, in the order the questions are asked — which is the order
     they will read in on the basket line and on the ticket. */
  `var pkChosen=function(){var out=[];if(!pk)return out;` +
  `for(var i=0;i<pk.o.length;i++){var g=pk.o[i],sel=pk.s[g.id]||[];` +
  `for(var j=0;j<g.choices.length;j++){var c=g.choices[j];` +
  `if(sel.indexOf(c.id)<0)continue;` +
  /* A SOLD-OUT ANSWER IS NEVER CARRIED OUT OF THE PICKER, even if it somehow
     got ticked — a default that ran out between the page rendering and the tap
     is the real case. The server refuses it too (§120 rule 1A); this is the
     half that stops the customer being shown a price they cannot pay. */
  `if(c.out)continue;` +
  `out.push({option_id:g.id,choice_id:c.id,q_en:g.q_en,q_cn:g.q_cn,` +
  `en:c.en,cn:c.cn,d:c.d})}}` +
  `return out};` +
  `var pkPrice=function(){if(!pk)return 0;var t=pk.p,a=pkChosen();` +
  `for(var i=0;i<a.length;i++)t+=(Number(a[i].d)||0);` +
  `return Math.round(t*100)/100};` +
  /* The first required question with nothing ticked, or null. Asked in the
     order the questions are asked, so the message names the one the customer
     will meet first when they scroll back up. */
  `var pkMissing=function(){if(!pk)return null;` +
  `for(var i=0;i<pk.o.length;i++){var g=pk.o[i];if(!g.req)continue;` +
  `var sel=pk.s[g.id]||[],live=pkLive(g,sel);` +
  `if(!live)return g;` +
  /* §153's FLOOR, and it is the same refusal rather than a second one. A
     customer sitting on one crunchy side out of the two the question asks for
     has answered it — just not enough — so "please choose" still names the
     right question, and the count in brackets is what tells them what is
     short. The ceiling is NOT checked here: a tick that would break it never
     goes on in the first place, so there is nothing to refuse at the button. */
  `if(g.min&&live<g.min)return g}return null};` +
  `var pkFind=function(g,id){for(var i=0;i<g.choices.length;i++)` +
  `if(g.choices[i].id===id)return g.choices[i];return null};` +
  /* HOW MANY ANSWERS ARE ACTUALLY ON. Counted rather than read off
     sel.length, because a choice can sell out while the sheet is open and a
     tick on a dead answer is not an answer — the same measure pkMissing has
     always used, and the same one the endpoint uses (pickableChoiceCount).
     Counting the raw array instead would let a sold-out tick fill the
     ceiling, locking the customer out of the sides they can still have. */
  `var pkLive=function(g,sel){var n=0;` +
  `for(var i=0;i<sel.length;i++){var c=pkFind(g,sel[i]);if(c&&!c.out)n++}` +
  `return n};` +
  /* THE SENTENCE UNDER THE QUESTION, in both languages, or null for a group
     with no limit — which is every group authored before §153 and stays the
     shape it always was. Mirrors public/shop.html's limHint() case for case;
     if these two ever disagree the same product reads differently on the two
     pages the same customer might open. */
  `var limTxt=function(g){var mn=g.min||0,mx=g.max||0;` +
  `if(mn&&mx){var t=(mn===mx)?(''+mn):(mn+'\u2013'+mx);` +
  `return [L_CH_EN+t,L_CH_CN+t+L_N_CN]}` +
  `if(mx)return [L_UPTO_EN+mx,L_UPTO_CN+mx+L_N_CN];` +
  `if(mn)return [L_ATL_EN+mn,L_ATL_CN+mn+L_N_CN];` +
  `return null};` +
  `var pkPaint=function(){var h='';` +
  `for(var i=0;i<pk.o.length;i++){var g=pk.o[i],sel=pk.s[g.id]||[];` +
  `h+='<div class=\"og\"><div class=\"og-q\">'+bi(g.q_en,g.q_cn)+` +
  `(g.req?' <span class=\"og-req\">*</span>':'')+'</div>';` +
  /* The rule, printed under the question it governs. A group with no limit
     prints nothing, so nothing on this page changes shape for the menus that
     were authored before §153. */
  `var lt=limTxt(g);` +
  `if(lt)h+='<div class=\"og-lim\">'+bi(lt[0],lt[1])+'</div>';` +
  /* AT THE CEILING, every answer not already on stops taking taps. Measured
     once for the whole group rather than per row — it is a fact about the
     question, not about any one answer. */
  `var full=(g.max&&pkLive(g,sel)>=g.max)?1:0;` +
  `for(var j=0;j<g.choices.length;j++){var c=g.choices[j];` +
  `var on=(sel.indexOf(c.id)>=0&&!c.out);` +
  /* A TICKED ROW IS NEVER CAPPED. Unticking is the only way back under the
     ceiling, so the rows that can do it must stay live — cap the ticked ones
     too and the customer is stuck at two with no way to change their mind. */
  `var cap=(!on&&full&&!c.out)?1:0;` +
  `h+='<button type=\"button\" class=\"oc'+(g.multi?' multi':'')+` +
  `(on?' on':'')+(c.out?' out':'')+(cap?' cap':'')+'\"'+` +
  `((c.out||cap)?' disabled':'')+' data-og=\"'+g.id+'\" data-oc=\"'+c.id+'\">'+` +
  /* THE BOX IS EMPTY OR IT HAS A TICK, and it is only drawn for a question
     that accepts more than one answer. A single-answer question keeps the
     bare row: a box that can only ever hold one tick is a radio drawn as a
     checkbox, which is the opposite of the distinction being made here. */
  `(g.multi?'<span class=\"oc-x\">'+(on?'\\u2713':'')+'</span>':'')+` +
  `'<span class=\"oc-l\">'+bi(c.en,c.cn)+'</span>'+` +
  `'<span class=\"oc-d\">'+(c.out?L_OUT:(c.d?('+'+money(c.d)):''))+'</span>'+` +
  `'</button>'}` +
  `h+='</div>'}` +
  `body.innerHTML=h;` +
  /* The button carries the running price, so the cost of an extra is read
     where it is chosen rather than discovered in the basket. */
  `oAdd.innerHTML=L_ADD+' \u00b7 '+money(pkPrice())};` +
  /* §129 · THE SIZE PICKER — a third face of this panel, after the basket and
     the option picker, and built out of the option picker's own furniture: the
     same .og block, the same .oc rows, the same ink ground on the one that is
     chosen. A customer who has answered a question on this menu has already
     learned how to read it.

     IT IS BUILT FROM THE CARD'S HIDDEN BUTTONS, NOT FROM A SECOND JSON BLOB.
     Every size already rides on the card as a real .add button carrying its id,
     its price, whether it asks questions and whether it is sold out — so the
     picker reads the same source the basket does, and there is nothing to keep
     in step. A sold-out size is DRAWN, greyed and refused rather than omitted:
     the same answer §120 rule 1A gives a dead extra, for the same reason.

     NO FOOT. The option picker's foot carries a running price because ticking
     an extra changes it; choosing a size IS the decision, so the tap acts and
     a button to confirm it would be a second tap for nothing. */
  `var openSizes=function(b){var card=b.closest?b.closest('.it'):null;if(!card)return;` +
  `var btns=card.querySelectorAll('.vadds .add');if(!btns.length)return;` +
  `var h='<div class=\"og\">';` +
  `for(var i=0;i<btns.length;i++){var m=btns[i];` +
  `var out=m.getAttribute('data-out')==='1';` +
  // A size with no label typed against it still has to be choosable, so it
  // falls back to the product's own name rather than drawing an empty row, and
  // a label typed in only one language falls back to the other rather than
  // leaving that language's span empty. bi() escapes both halves — these
  // strings are the office's and come back out of an attribute.
  `var le=m.getAttribute('data-vl-en')||'',lc=m.getAttribute('data-vl-cn')||'';` +
  `if(!le&&!lc){le=m.getAttribute('data-en')||'';lc=m.getAttribute('data-cn')||''}` +
  `var lab=bi(le||lc,lc||le);` +
  `h+='<button type=\"button\" class=\"oc'+(out?' out':'')+'\"'+(out?' disabled':'')+` +
  `' data-vpick=\"'+m.getAttribute('data-add')+'\">'+` +
  `'<span class=\"oc-l\">'+lab+'</span>'+` +
  `'<span class=\"oc-d\">'+(out?L_OUT:money(parseFloat(m.getAttribute('data-p'))||0))+'</span>'+` +
  `'</button>'}` +
  `h+='</div>';` +
  `pk=null;oErr.hidden=true;foot.hidden=true;optFoot.hidden=true;errEl.hidden=true;` +
  `ttl.innerHTML=L_SIZE;` +
  `nmEl.innerHTML=bi(b.getAttribute('data-en')||'',b.getAttribute('data-cn')||'');` +
  `nmEl.hidden=false;body.innerHTML=h;shOpen(sheet);body.scrollTop=0};` +
  `var openPicker=function(b){var pid=parseInt(b.getAttribute('data-add'),10);` +
  `var o=optsFor(pid);` +
  /* NO QUESTIONS AFTER ALL — the flag and the template disagree, which can
     only happen if one was edited away. Add the product rather than opening an
     empty sheet over it. */
  `if(!o||!o.length){addLine(pid,parseFloat(b.getAttribute('data-p'))||0,` +
  `b.getAttribute('data-en'),b.getAttribute('data-cn'),[]);return}` +
  `pk={pid:pid,p:parseFloat(b.getAttribute('data-p'))||0,` +
  `en:b.getAttribute('data-en'),cn:b.getAttribute('data-cn'),o:o,s:{}};` +
  /* PRE-TICKED DEFAULTS, AND ONLY THE ONES THAT ARE STILL THERE. A default
     that has run out is left alone rather than ticked-then-refused — §120's
     rule 1A greys it out, and a picker that opens with a dead answer already
     chosen would be asking the customer to undo it. */
  `for(var i=0;i<o.length;i++){var g=o[i],d=[];` +
  `for(var j=0;j<g.choices.length;j++){var c=g.choices[j];` +
  `if(c.def&&!c.out){d.push(c.id);if(!g.multi)break}}` +
  `pk.s[g.id]=d}` +
  `oErr.hidden=true;foot.hidden=true;optFoot.hidden=false;errEl.hidden=true;` +
  `ttl.innerHTML=L_OPTS;nmEl.innerHTML=bi(pk.en,pk.cn);nmEl.hidden=false;` +
  `pkPaint();shOpen(sheet);body.scrollTop=0};` +
  /* Leaving the picker puts the sheet back to being the basket. Every face of
     this panel repaints the heading and swaps the foot, or it wears the last
     one's. */
  `var pkClose=function(){pk=null;optFoot.hidden=true;oErr.hidden=true;` +
  `nmEl.hidden=true;nmEl.innerHTML=''};` +
  `var addLine=function(pid,price,en,cn,ops){` +
  `var ch=[];for(var i=0;i<ops.length;i++)ch.push(ops[i].choice_id);` +
  `var k=ckey(pid,ch);` +
  `if(!cart[k])cart[k]={pid:pid,qty:0,price:price,en:en,cn:cn,ops:ops};` +
  // MAX_QTY on the server is 20 and it refuses past it. Stopping here as well
  // means the customer meets the ceiling as a button that stops moving rather
  // than as an error after they have filled in their name.
  `if(cart[k].qty<20)cart[k].qty++;paintBar();if(!sheet.hidden&&!pk)paintSheet()};` +
  /* THE + EITHER ADDS OR ASKS, and the card said which before it was tapped
     (data-ask). A product with no questions on it behaves exactly as it always
     has — one tap, one unit, the photo flies into the bar — because most of a
     menu has no questions and making every product cost a sheet would be a
     tax on the common case. */
  `var add=function(b){` +
  // §129: THREE OUTCOMES NOW, and the card said which before it was tapped.
  // A product with sizes offers them; one with questions asks them; the rest
  // still add in one tap, because most of a menu is the last case.
  `if(b.getAttribute('data-sizes')==='1'){openSizes(b);return}` +
  `var pid=parseInt(b.getAttribute('data-add'),10);` +
  `if(b.getAttribute('data-ask')==='1'){openPicker(b);return}` +
  `addLine(pid,parseFloat(b.getAttribute('data-p'))||0,` +
  `b.getAttribute('data-en'),b.getAttribute('data-cn'),[])};` +
  // THE FLIGHT RUNS AFTER add(), NOT INSIDE IT, and the order is the whole
  // trick: add() calls paintBar(), which is what un-hides the bar on the very
  // first tap. Measuring the target before that would measure a hidden element
  // and send the first product of every order to the top-left corner.
  `var fly=function(b){` +
  `if(shRM())return;` +
  `var card=b.closest?b.closest('.it'):null;if(!card)return;` +
  `var img=card.querySelector('.ph img');if(!img||!img.src)return;` +
  `var from=img.getBoundingClientRect();` +
  // A card scrolled off the screen has nothing to throw. Nothing is better
  // than a photo sailing in from somewhere the customer was not looking.
  `if(from.bottom<0||from.top>window.innerHeight||from.width===0)return;` +
  `var t=nEl.getBoundingClientRect();if(t.width===0)return;` +
  `var f=document.createElement('div');f.className='fly';` +
  `f.style.backgroundImage='url("'+img.src+'")';` +
  `f.style.left=from.left+'px';f.style.top=from.top+'px';` +
  `f.style.width=from.width+'px';f.style.height=from.height+'px';` +
  `document.body.appendChild(f);` +
  `var dx=(t.left+t.width/2)-(from.left+from.width/2);` +
  `var dy=(t.top+t.height/2)-(from.top+from.height/2);` +
  // Read a layout value before changing the transform, or the browser is
  // entitled to collapse both styles into one frame and play no transition at
  // all. This line looks pointless and is the reason the flight happens.
  `f.getBoundingClientRect();` +
  `f.style.transform='translate('+dx+'px,'+dy+'px) scale(.14)';` +
  `f.style.opacity='.2';` +
  // Removed on a timer as well as on the event: a transition that never fires
  // (a background tab, a browser that skipped it) must not leave a photo
  // pinned over the menu for the rest of the visit.
  `var gone=function(){if(f.parentNode)f.parentNode.removeChild(f)};` +
  `f.addEventListener('transitionend',gone,false);setTimeout(gone,700)};` +
  `document.addEventListener('click',function(e){` +
  /* TICKING AN ANSWER. A single-answer question REPLACES what was ticked — the
     customer is changing their mind, not adding a second sugar level — and a
     multi toggles. A required single cannot be un-ticked back to nothing by
     tapping the one that is already on: that would be an empty required
     question the customer did not ask for, and they have no way to see they
     caused it. */
  /* §129 · CHOOSING A SIZE. The row carries the sibling's product id and
     nothing else: the click goes to that sibling's own hidden + , which is the
     single add path §120 built, so the price, the name and whether this size
     asks questions all come from the one place that already knows them.

     WHAT HAPPENS NEXT IS NOT DECIDED HERE. That + either drops the line into
     the basket or opens the option picker over this same panel, and which one
     is the button's business. So the size face is cleared FIRST and the sheet
     is closed only if nothing re-opened it — asked of the sheet afterwards
     rather than predicted from data-ask, because predicting it would be a
     second reading of the same flag and the two would disagree the first time
     one moved. */
  `var vp=e.target.closest?e.target.closest('.oc[data-vpick]'):null;` +
  `if(vp){if(vp.disabled)return;` +
  `var vid=vp.getAttribute('data-vpick');` +
  `var real=document.querySelector('.vadds .add[data-add=\"'+vid+'\"]');` +
  `if(!real)return;` +
  `body.innerHTML='';nmEl.hidden=true;nmEl.innerHTML='';` +
  `shClose(sheet);` +
  `real.click();` +
  `return}` +
  `var oc=e.target.closest?e.target.closest('.oc'):null;` +
  `if(oc&&pk){if(oc.disabled)return;` +
  `var gid=parseInt(oc.getAttribute('data-og'),10);` +
  `var cid=parseInt(oc.getAttribute('data-oc'),10);` +
  `var g=null;for(var gi=0;gi<pk.o.length;gi++)if(pk.o[gi].id===gid)g=pk.o[gi];` +
  `if(!g)return;` +
  `var sel=pk.s[gid]||[],at=sel.indexOf(cid);` +
  /* The ceiling, guarded at the model and not only at the paint. The row is
     already disabled, so this catches the ways a tap can arrive anyway — a
     keyboard, a stale paint, an assistive click — and it is three lines
     rather than a trust that the class and the array can never disagree. */
  `if(g.multi){if(at>=0)sel.splice(at,1);` +
  `else{if(g.max&&pkLive(g,sel)>=g.max)return;sel.push(cid)}}` +
  `else if(at<0)sel=[cid];` +
  `else if(!g.req)sel=[];` +
  `pk.s[gid]=sel;oErr.hidden=true;pkPaint();return}` +
  `var b=e.target.closest?e.target.closest('.add'):null;` +
  /* The flight is for a product that went STRAIGHT into the basket. One that
     opens a picker has not been added yet, and a photo sailing into the bar
     before the customer has answered anything would be telling them a lie. */
  // §129 widens "has not been added yet" to cover a card that offers sizes:
  // the flight is for a product that went STRAIGHT into the basket, and one
  // whose sizes are still being chosen is no more added than one whose
  // questions are. The size row's own tap clicks the sibling's real + , which
  // comes back through here and flies then, once, from the same card.
  `if(b){var asked=b.getAttribute('data-ask')==='1'||b.getAttribute('data-sizes')==='1';` +
  `add(b);if(!asked)fly(b);return}` +
  `var d=e.target.getAttribute&&e.target.getAttribute('data-d');` +
  `if(d){if(cart[d]){cart[d].qty--;if(cart[d].qty<1)delete cart[d]}` +
  `paintBar();paintSheet();closeIfEmpty();return}` +
  `var iu=e.target.getAttribute&&e.target.getAttribute('data-i');` +
  `if(iu){if(cart[iu]&&cart[iu].qty<20)cart[iu].qty++;paintBar();paintSheet();return}` +
  `},false);` +
  // The bar's two states answer the tap differently: a basket opens the sheet,
  // a placed order goes to that order's own page.
  //
  // ONE ORDER GOES STRAIGHT THERE; SEVERAL OPEN THE LIST. The single order is
  // the case at almost every counter, and putting a list in front of it would
  // charge every customer a tap to be shown one row they then have to tap
  // again.
  `document.getElementById('cbarOpen').addEventListener('click',function(){` +
  `if(count()===0&&mine.length){if(mine.length===1){location.href=mine[0].u;return}` +
  `openOrders();return}` +
  `pkClose();errEl.hidden=true;foot.hidden=false;paintSheet();shOpen(sheet)},false);` +
  /* RULE 2B (§120). A required question left unanswered BLOCKS, and the refusal
     NAMES THE QUESTION — "Please choose: Sugar level", not a bare "please
     choose", because a picker with four questions on it gives the customer no
     way to tell which one it means. Both halves are the live pair the web
     storefront and the mini app already refuse with, question text and all.
     The alternative — silently pre-picking the first answer and never blocking
     — was considered and rejected in §120: a defaulted sugar level is a wrong
     drink the customer did not order and the counter cannot tell was never
     chosen. */
  `oAdd.addEventListener('click',function(){if(!pk)return;` +
  `var miss=pkMissing();` +
  /* NAMING THE COUNT, but only when the count is the news. A question with a
     floor of one is answered by any single tick, so "(Choose 1)" after it
     tells the customer nothing they have not just been told. At two or more
     it is the whole message: the customer looking at one ticked side needs to
     read that the question wanted two, not just that it wants something. */
  `if(miss){var mt=(miss.min>1)?limTxt(miss):null;` +
  `oErr.innerHTML=bi(L_PICK_EN+miss.q_en+(mt?(L_PO_EN+mt[0]+L_PC_EN):''),` +
  `L_PICK_CN+miss.q_cn+(mt?(L_PO_CN+mt[1]+L_PC_CN):''));` +
  `oErr.hidden=false;return}` +
  /* pkPrice(), NOT pk.p. The basket line carries the price the customer will
     actually be charged — base PLUS every delta they ticked — and pk.p is the
     base alone. Passing the base put a latte with a paid oat milk in the basket
     at its bare listing price while the server, which prices from its own
     tables, charged the extra too: the customer read one number on their phone
     and heard another at the till.
     Caught by the render suite, which adds a paid extra and then measures the
     basket line. */
  `var pid=pk.pid;` +
  `addLine(pk.pid,pkPrice(),pk.en,pk.cn,pkChosen());` +
  /* BACK TO WHERE THEY WERE, NOT ON TO THE CHECKOUT. §120 flipped this panel to
     the BASKET face after the questions were answered, on the reasoning that it
     is "the face that shows what has just been added". Reported by Ash from the
     live menu, ticking an extra on a salad: *"when i click add to basket it goes
     to chekcut instead going back to main menu."*

     HE IS RIGHT, AND THE TELL IS THAT NOTHING ELSE ON THIS MENU BEHAVES THAT
     WAY. Tapping + on a product with no questions adds it and leaves the
     customer exactly where they were, browsing, with the photo thrown into the
     bar. §129's size picker does the same. Only the question path ended
     somewhere else — and where it ended was a form asking for a name and a
     tender, which tells a customer who has just chosen a sugar level that they
     have finished shopping. A basket of one is the common case for that screen
     and it is the wrong one.

     THE CONFIRMATION WAS NEVER MISSING. The bar already carries the count and
     the running total, and the flight is what says WHICH product went in. Both
     are the same answer the plain + gives, so this path now gives it too: the
     photo flies here rather than at the tap that opened the picker, because
     that is the moment the line actually exists. §120's own note beside the
     flight said so — "a photo sailing into the bar before the customer has
     answered anything would be telling them a lie" — and this is the other
     side of that sentence.

     The basket is one tap away on the bar, where it was before any of this. */
  `pkClose();errEl.hidden=true;shClose(sheet);` +
  `var fb=document.querySelector('.add[data-add=\"'+pid+'\"]');if(fb)fly(fb)},false);` +
  /* Closing the panel from the picker must not leave the picker's foot behind
     for the basket to wear. */
  `var close=function(){pkClose();shClose(sheet)};` +
  `document.getElementById('sheetX').addEventListener('click',close,false);` +
  `document.getElementById('sheetBg').addEventListener('click',close,false);` +
  `document.addEventListener('keydown',function(e){if(e.key==='Escape')close()},false);` +
  `var fail=function(t){errEl.innerHTML=t;errEl.hidden=false};` +
  // HOW THEY MEAN TO PAY. Read off the bar's own data attribute, like the
  // currency — the shop either can take an in-page WeChat payment or cannot,
  // and this script is built once for every shop. When it cannot, `pm` stays
  // 'counter' for the whole visit and the row is not in the DOM to be tapped.
  //
  // NOTHING HERE LOOKS AT THE BROWSER. A customer who opened the menu from a
  // camera app rather than WeChat's own scanner may pick WeChat Pay and will be
  // told at the till instead (§50); the alternative — reading the user agent to
  // hide the button — is the branch §47 keeps off this page, and it would be
  // wrong on every browser WeChat ships next.
  `var pw=document.getElementById('cPw');` +
  `var pm=(bar.getAttribute('data-wxpay')==='1')?'wechat':'counter';` +
  `if(pw){pw.addEventListener('click',function(e){` +
  `var b=e.target.closest?e.target.closest('button[data-pm]'):null;if(!b)return;` +
  `pm=b.getAttribute('data-pm');` +
  `var all=pw.querySelectorAll('button[data-pm]');` +
  `for(var i=0;i<all.length;i++)all[i].className=(all[i]===b?'on':'');` +
  `},false)}` +
  // Submitting. The button locks for the round trip: a customer who taps twice
  // on a slow connection must not put two orders through the counter.
  `place.addEventListener('click',function(){if(sending)return;` +
  `var name=(nameEl.value||'').trim();` +
  `if(!name){fail(bi(${JSON.stringify('Name')},${JSON.stringify('姓名')}));nameEl.focus();return}` +
  `var k=ids();if(!k.length)return;` +
  /* THE LINE CARRIES ITS ANSWERS. `choices` is the chosen choice ids and
     nothing else — the labels, the questions and the deltas on the cart line
     are for drawing the basket, and the server looks all three up again from
     its own tables rather than trusting a price that arrived from a phone. */
  `var items=[];for(var i=0;i<k.length;i++){var ln=cart[k[i]];` +
  `var one={store_product_id:ln.pid,qty:ln.qty};` +
  `if(ln.ops&&ln.ops.length){one.choices=[];` +
  `for(var j=0;j<ln.ops.length;j++)one.choices.push(ln.ops[j].choice_id)}` +
  `items.push(one)}` +
  `sending=true;place.disabled=true;errEl.hidden=true;` +
  `fetch(location.pathname.replace(/\\/$/,'')+'/order',{method:'POST',` +
  `headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,items:items,pay_method:pm})})` +
  `.then(function(r){return r.json().then(function(j){return {s:r.status,j:j}})})` +
  `.then(function(o){sending=false;place.disabled=false;` +
  // A WeChat order leaves for the payment page and never draws the done screen
  // here: its number is shown there, after the money has actually arrived.
  // Counter orders are unchanged and land on done() as they always have.
  `if(o.s===201&&o.j&&o.j.data){` +
  `if(o.j.data.pay_url){location.href=o.j.data.pay_url;return}` +
  `done(o.j.data);return}` +
  // A refusal names the items rather than saying "something went wrong": the
  // customer is standing in the shop and can choose again in ten seconds if
  // they are told what went.
  `if(o.s===409&&o.j&&o.j.items&&o.j.items.length){var gone='';` +
  `for(var i=0;i<o.j.items.length;i++){var it=o.j.items[i];` +
  /* EVERY LINE OF THAT PRODUCT GOES, not the one keyed by its bare id. Since
     §120 the basket may hold a full-sugar latte and a half-sugar latte as two
     lines, and a latte that has sold out has sold out for both — deleting
     cart[pid] would have removed neither of them and left the customer
     resubmitting the same refusal. */
  `var pid=Number(it.store_product_id),ks=ids();` +
  `for(var q=0;q<ks.length;q++)if(cart[ks[q]].pid===pid)delete cart[ks[q]];` +
  `gone+='<div>'+bi(it.name_en,it.name_cn)+' — '+bi(${JSON.stringify('Sold out')},${JSON.stringify('售罄')})+'</div>'}` +
  `paintBar();paintSheet();closeIfEmpty();fail(gone);return}` +
  `fail(bi(${JSON.stringify('Please try again.')},${JSON.stringify('请重试。')}))})` +
  `.catch(function(){sending=false;place.disabled=false;` +
  `fail(bi(${JSON.stringify('Please try again.')},${JSON.stringify('请重试。')}))})},false);` +
  // THE PLACED ORDER. The number fills the screen because the entire next step
  // is somebody calling it across a room, and the customer's job is to hear it.
  // AND THE HEADING GOES, BECAUSE THIS FACE ALREADY HAS ONE. Every other face
  // repaints it — paintSheet() says basket, openOrders() says my orders — and
  // this one did not, so the panel drawing a placed order kept whichever word
  // was last set and stood there saying YOUR BASKET over the order that had
  // just emptied the basket. Exactly the lie the header comment on #sheetT
  // exists to forbid.
  //
  // EMPTIED RATHER THAN RENAMED, and that is the whole of the decision. The
  // face already states its own name below the number, and states it louder
  // than this header can: .done-h is "Order placed! · 下单成功！" set in a
  // bordered lime badge, against a plain 16px .sheet-t. A header above it
  // could only repeat that, or reach for a noun that is not true here —
  // L_MINE is "My orders", plural, and the name of the LIST face, which this
  // is not; L_ORD is already spoken by .done-o at the foot of this same
  // screen. v4.160 ruled on this exact question one line lower, when it put
  // no heading over the order's lines: YOUR BASKET is false on a placed order
  // and anything else would have had to be minted.
  //
  // Nothing is composed: an empty .sheet-t is a state this panel already has
  // (the detail sheet clears its own title for a product with no name), it
  // keeps flex:1 so the × stays where the customer last saw it, and no
  // vocabulary entry is owed for a word that is not said.
  `var done=function(d){cart={};pkClose();foot.hidden=true;ttl.innerHTML='';` +
  // REMEMBERED BEFORE IT IS DRAWN, so the one thing that must survive this
  // screen is written before anything can go wrong drawing it.
  // NEWEST FIRST, AND THE ONE BEFORE IT IS KEPT. Deduplicated on the address
  // rather than the number, because the number restarts at 1 each trading day
  // and the address never repeats — and a done screen redrawn for an order
  // already in the list must move it to the front, not enter it twice.
  `if(d.order_url){var e0={n:d.order_code,t:d.total,u:d.order_url,ts:Date.now()};` +
  `var nx=[e0];for(var i=0;i<mine.length&&nx.length<MAXO;i++){` +
  `if(mine[i].u!==e0.u)nx.push(mine[i])}mine=nx;` +
  `try{localStorage.setItem(OKEY,JSON.stringify(mine))}catch(e){/* a phone that cannot remember still shows the bar for this visit; mine is set in memory above */}}` +
  `paintBar();` +
  // ONE BLOCK WITH ONE LEFT EDGE, the same one the order page draws: the number
  // that will be called, the name it will be called with, and the reference
  // that identifies the order, rather than three centred lines and the
  // reference stranded at the bottom under the money.
  `body.innerHTML='<div class="done"><div class="done-hd">'+` +
  `'<div class="done-n">'+esc(String(d.order_code))+'</div>'+` +
  `'<div class="done-who"><div class="done-nm">'+esc(String(d.name||''))+'</div>'+` +
  `'<div class="done-o">'+bi(${JSON.stringify('Order')},${JSON.stringify('订单号')})+' '+esc(String(d.order_no||''))+'</div>'+` +
  `'</div></div>'+` +
  `'<div class="done-h">'+bi(${JSON.stringify('Order placed!')},${JSON.stringify('下单成功！')})+'</div>'+` +
  // THE SUB-LINE MOVES ABOVE THE AMOUNT, which is where the order page has
  // always had it. It used to sit below, and the note that stood here said the
  // difference was harmless because what had to agree was the lines-then-figure
  // reading. With the two surfaces now drawing the same block, "harmless" is
  // not a reason to keep them different.
  `'<div class="done-s">'+bi(${JSON.stringify('Pay at the counter.')},${JSON.stringify('请到收银台付款。')})+'</div>'+` +
  // WHAT THEY ORDERED, IMMEDIATELY ABOVE THE AMOUNT. The lines and then what
  // they come to — the order the basket they just closed read in, and the order
  // a receipt reads in. A total printed above the things it totals asks the
  // customer to read the screen backwards.
  //
  // The sub-line sits BELOW the amount on this screen and above it on the order
  // page. That is pre-existing and left alone: what had to agree between the
  // two surfaces is that the lines lead into the figure, and here they do.
  `lineRows(d.items)+` +
  // THE AMOUNT, because they are about to pay it. The screen has always said
  // where to pay and never how much, which left the customer to remember a
  // figure from the basket they just closed. Same money() the basket and the
  // bar use, so the number they were shown before submitting is the number
  // they are shown after it — a second formatter here could round differently
  // and would be read as a price that changed at the till.
  `'<div class="done-amt"><span class="done-amt-l">'+bi(${JSON.stringify('Total')},${JSON.stringify('合计')})+'</span>'+` +
  `'<span class="done-amt-v">'+money(d.total)+'</span></div>'+` +
  // NO LINK HERE. The way back is the bar, which appears the moment this sheet
  // closes and carries the same number and amount — one route to the order
  // page, not two. A link here would also have needed a label, and the only
  // locked pair for the noun is 订单号 ("order number"), which reads as a
  // heading and not as somewhere to go.
  `'</div>';shOpen(sheet)};` +
  /* AND THE BAR IS PAINTED ONCE, HERE, BEFORE ANYBODY TOUCHES ANYTHING.

     THIS IS THE HALF OF THE REPORT THAT WAS STILL BROKEN. The receipt was read
     at startup and the bar was only ever repainted by add(), by the steppers
     and by done() — so closing the sheet showed the order (done() had just
     painted it) and RELOADING THE PAGE showed nothing at all. A second scan of
     the QR code is a fresh load, and a fresh load never painted: the customer
     who left the screen and came back was told, correctly and uselessly, that
     the shop had a menu.

     Nothing else changes for an empty phone: with no basket and no remembered
     order this call hides the bar, which is what it already was. */
  `paintBar();` +
  `})();`;

// ─── WHOSE SIGNATURE THIS MENU SIGNS WITH (§179) ────────────────────────
//
// NULL MEANS ROOTS, which is exactly the argument signatureFor() takes, and is
// how routes/retail.js already answers the mini app's own config: a customer
// request and an operator request must not be answered differently.
//
// A TENANT THAT CANNOT BE RESOLVED IS SIGNED WITH NOTHING, never with Roots'.
// signatureFor({id:0}) answers no cast, no tagline and no house line, which
// draws no colophon at all. §158's whole finding was that the failure mode of
// this resolution used to be somebody else's mascot on a stranger's product.
function menuSignature(req) {
  try {
    const tid = resolvePublicTenant(req);
    const row = tid
      ? mainDb.prepare('SELECT id, name, brand_name FROM tenants WHERE id = ?').get(tid)
      : null;
    return brandSignature.signatureFor(row);
  } catch (e) {
    return brandSignature.signatureFor({ id: 0, name: '' });
  }
}

// ─── What a product's detail sheet knows ────────────────────────────────
//
// EVERY LABEL IS THE MINI APP'S OWN, copied from its product-blocks component:
//   Ingredients · 配料表      Allergens · 过敏原
//   Contains · 含有           May contain traces of · 可能含有微量
// Nothing here is composed. The customer who reads a product in the app and the
// one standing at the counter are the same person, and two wordings for
// "may contain traces of" would be the defect §30 exists to prevent.

// The sheet's body for one product. Returns '' when the product has nothing to
// say — the caller then renders no sheet at all and the card stays untappable,
// because an empty panel is worse than a card that does not respond.
function detailBody(it, code, listed, sig, qrShown) {
  /* §132 — EVERY BLOCK THE OFFICE WROTE, IN THE ORDER IT WROTE THEM.
     §120 read two block types, §129 added the paragraph and the note, and this
     reads all thirteen. The order is no longer this function's: it was a fixed
     prose-then-ingredients-then-allergens template, and it is now whatever the
     office laid out in the editor, which is what "same as the mini app" means
     before any single block is drawn. */
  /* §228 — THE TENANT'S ALLOW-LIST TRAVELS IN, it is not read here. Every
     product on this page resolves against the same list and it costs one row,
     so it is read once for the request beside the signature rather than once
     per product — and a reader that fetched it itself could not be called from
     the mini app's harness or from a script holding no tenant handle. */
  const blocks = blockRead.pageBlocks(it.description_blocks, qrShown);
  const nut = nutritionRows(it.nutrition);
  const L = blockRead.LABELS;

  /* §120's RULE SURVIVES, WIDENED TWICE. A product with nothing to say still
     does not open: a page carrying a photo and a name the card already shows is
     the same empty panel the sheet refused, and a card that does not respond is
     better than one that opens onto nothing. What counts as something to say is
     now any block at all, plus having more than one size — a collapsed card
     whose picker could not be reached would be a size nobody can buy. */
  if (!blocks.length && !nut && !(it.variants && it.variants.length > 1)) return '';

  // A bilingual pair where ONE language may be missing: the other stands in,
  // because a blank half reads as a fault rather than as an omission.
  const p2 = (x) => bi(x.en || x.cn, x.cn || x.en);

  // WHICH CHIPS CARRY A RESERVED HALF-BOX AT ONE END. A CJK bracket occupies a
  // full character cell wherever it sits, so one at either end of a chip's text
  // is mostly blank — the CSS above trims it back. Brackets only: a full-width
  // comma or period cannot end a name, and trimming one that had not been
  // measured would be moving something on a guess.
  const trimmed = (t) => (/^[（【《「『〔｛]/.test(t) ? ' tl' : '') +
                         (/[）】》」』〕｝]$/.test(t) ? ' tr' : '');

  // The heading two-thirds of these blocks share.
  //
  // NOTHING PASSES A COUNT, AND THE PARAMETER STAYS. product-blocks.wxss
  // carries .pb-section-tag but product-blocks.wxml never renders it — it is
  // dead style in the component — so the "3 MOMENTS" / "6 STEPS" / "keep it
  // right" line beside three of these headings was on this page and on no other
  // surface. blockRead still builds the tags and .pb-h-r is still styled below,
  // so putting one back is passing it again at the call site and nothing else.
  const head = (h, tag) => `<div class="pb-h"><div class="pb-h-l">${p2(h)}</div>` +
    (tag ? `<div class="pb-h-r">${p2(tag)}</div>` : '') + `</div>`;

  // ONE BLOCK, ONE BAND. The wrapper .pb carries the space above a block
  // and the hairline between it and the one before; the block itself gives up
  // its own top margin to it. Applied by the caller rather than inside one(),
  // because the nutrition column appended AFTER the blocks is a band too and
  // reaches this from the other side.
  const band = (h) => h ? `<div class="pb">${h}</div>` : '';

  // THE HERO INGREDIENT IS FILLED, THE REST OUTLINED — the mini app's own chip
  // cloud, where `lead` marks the one the product is mostly made of. A pct the
  // office stated rides on the chip; most have none and that is normal.
  const chipCloud = (items) => items.map(x => {
    const pct = x.pct == null ? '' : ` <span class="pct">${esc(String(x.pct))}%</span>`;
    return `<span class="ichip${x.lead ? ' lead' : ''}">` +
      bi(x.name_en || x.name_cn, x.name_cn || x.name_en) + pct + `</span>`;
  }).join('');

  // CONTAINS AND MAY-CONTAIN ARE TWO DIFFERENT STATEMENTS and are never merged.
  // The first is what is in the food; the second is what the line it was made
  // on also handles. A person avoiding an allergen needs both and needs to know
  // which is which — this is the whole reason the sheet reads the office's card
  // rather than deriving anything.
  const algRow = (label, en, cn, cls) => {
    if (!en.length && !cn.length) return '';
    const one = (list) => list.map(t =>
      `<span class="achip ${cls}${trimmed(t)}">${esc(t)}</span>`).join('');
    return `<div class="arow"><div class="alab">${bi(label.en, label.cn)}</div>` +
      `<div class="achips"><span class="l-en chipset">${one(en)}</span>` +
      `<span class="l-cn chipset">${one(cn.length ? cn : en)}</span></div></div>`;
  };
  const algCard = (a) =>
    `<div class="acard"><div class="atitle">${bi(L.allergens.en, L.allergens.cn)}</div>` +
    (algRow(L.contains, a.contains_en, a.contains_cn, 'has') ||
      // "None declared" is the mini app's own empty state for this row, and it
      // is a statement rather than a blank: the office looked and found none.
      `<div class="arow"><div class="alab">${bi(L.contains.en, L.contains.cn)}</div>` +
      `<div class="achips"><span class="anone">${bi(L.none.en, L.none.cn)}</span></div></div>`) +
    algRow(L.mayContain, a.may_en, a.may_cn, 'may') +
    `</div>`;

  const nutCard = (title, basis, rows) =>
    `<div class="nut"><div class="nut-top"><div class="nut-ttl">${p2(title)}</div>` +
    (basis && (basis.en || basis.cn) ? `<div class="nut-bs">${p2(basis)}</div>` : '') +
    `</div>${rows}</div>`;

  const nutRows = (rows) => rows.map(r => {
    const k = r.kind === 'parent' ? ' p' : (r.kind === 'child' ? ' c' : '');
    return `<div class="nr${k}"><span class="nr-l">${p2(r.label)}</span>` +
      `<span class="nr-r">${esc(r.value)}</span></div>`;
  }).join('');

  const one = (b) => {
    if (b.type === 'spec_strip') {
      return `<div class="pb-spec">` + b.cells.slice(0, 3).map(c =>
        `<div class="pb-spec-c"><div class="pb-spec-k">${p2(c.k)}</div>` +
        `<div class="pb-spec-v">${p2(c.v)}</div></div>`).join('') + `</div>`;
    }
    if (b.type === 'hero_intro') {
      /* THE HIGHLIGHT PHRASE IS MARKED INLINE, WHICH IS WHY THIS CANNOT USE
         bi(). bi() escapes a whole string and wraps it in the two language
         spans; the phrase needs markup INSIDE one of those spans, so each
         language's segments are assembled here and each piece escaped on its
         own. Reported by Ash against the editor's preview: the slab was drawn
         there and nowhere on the live page. */
      const run = (segs) => segs.map(x => x.hl
        ? `<span class="pb-hl">${esc(x.text)}</span>` : esc(x.text)).join('');
      const bodyHtml = (b.segs && (b.segs.en.length || b.segs.cn.length))
        ? `<span class="l-en">${run(b.segs.en.length ? b.segs.en : b.segs.cn)}</span>` +
          `<span class="l-cn">${run(b.segs.cn.length ? b.segs.cn : b.segs.en)}</span>`
        : '';
      return `<div class="dt-p">` +
        ((b.kicker.en || b.kicker.cn) ? `<div class="dt-pk">${p2(b.kicker)}</div>` : '') +
        (bodyHtml ? `<div class="dt-pb">${bodyHtml}</div>` : '') +
        `</div>`;
    }
    if (b.type === 'why') {
      /* NOT head(): the component gives this one block a 22rpx kicker where
         every other head is the 52rpx headline. See .pb-why-h. */
      return `<div class="pb-why-h">${p2(b.head)}</div>` + b.rows.map((r, i) =>
        `<div class="pb-why-r${i === 0 ? ' first' : ''}">` +
        `<div class="pb-why-n">${esc(String(i + 1).padStart(2, '0'))}</div>` +
        `<div class="pb-why-c">${p2(r)}</div></div>`).join('');
    }
    if (b.type === 'ingredients_chips' || b.type === 'ingredients_line') {
      /* THE SAME HEADLINE EVERY OTHER BLOCK WEARS. The component heads both
         ingredient blocks with .pb-section-h3 — the big one — and this page
         had them under .dt-k, the small kicker it uses for a field label.
         Paired with the why block above, the two were swapped. The words are
         the component's own headLabel, already in blockRead.LABELS. */
      return head(L.ingredients) +
        `<div class="ichips">${chipCloud(b.items)}</div>`;
    }
    if (b.type === 'allergen_card') return algCard(b.card);
    if (b.type === 'how_to_use') {
      return head(b.head) +
        `<div class="pb-how${b.cols === 4 ? ' c4' : ''}">` + b.tiles.map(t =>
          `<div class="pb-how-t">` +
          (t.icon ? `<div class="pb-how-i">${esc(t.icon)}</div>` : '') +
          ((t.lbl.en || t.lbl.cn) ? `<div class="pb-how-l">${p2(t.lbl)}</div>` : '') +
          ((t.sub.en || t.sub.cn) ? `<div class="pb-how-s">${p2(t.sub)}</div>` : '') +
          `</div>`).join('') + `</div>`;
    }
    if (b.type === 'storage_box') {
      const card = (c) => !c ? '' :
        `<div class="pb-store-c${c.alt ? ' alt' : ''}">` +
        (c.icon ? `<div class="pb-store-i">${esc(c.icon)}</div>` : '') +
        ((c.head.en || c.head.cn) ? `<div class="pb-store-h">${p2(c.head)}</div>` : '') +
        ((c.num.en || c.num.cn) ? `<div class="pb-store-n${c.long ? ' long' : ''}">${p2(c.num)}</div>` : '') +
        ((c.unit.en || c.unit.cn) ? `<div class="pb-store-u">${p2(c.unit)}</div>` : '') +
        `</div>`;
      return head(b.head) +
        `<div class="pb-store">${card(b.left)}${card(b.right)}</div>` +
        ((b.note.en || b.note.cn) ? `<div class="pb-store-note">${p2(b.note)}</div>` : '');
    }
    if (b.type === 'notes_callout') {
      // The asterisk is a real span, not a ::before, so the suite can see it.
      return `<div class="pb-note"><span class="pb-note-m">✱</span>` +
        `<span class="pb-note-t">${p2(b.text)}</span></div>`;
    }
    if (b.type === 'big_stat') {
      return `<div class="pb-stat">` +
        `<span class="pb-stat-d pb-stat-d1">·</span>` +
        `<span class="pb-stat-d pb-stat-d2">·</span>` +
        (b.stat ? `<div class="pb-stat-n">${esc(b.stat)}</div>` : '') +
        ((b.what.en || b.what.cn) ? `<div class="pb-stat-w">${p2(b.what)}</div>` : '') +
        ((b.claim.en || b.claim.cn) ? `<div class="pb-stat-c">${p2(b.claim)}</div>` : '') +
        `</div>`;
    }
    if (b.type === 'pull_quote') {
      // THE QUOTES ARE DRAWN AROUND EACH LANGUAGE SEPARATELY. A CSS ::before
      // would put one pair around the element and both halves would share it —
      // so the hidden language's quote marks would hang beside the visible
      // language's text.
      const q = (v) => v ? '“' + v + '”' : '';
      return `<div class="pb-qt">` +
        ((b.text.en || b.text.cn)
          ? `<div class="pb-qt-p">${bi(q(b.text.en || b.text.cn), q(b.text.cn || b.text.en))}</div>` : '') +
        ((b.who.en || b.who.cn) ? `<div class="pb-qt-w">${p2(b.who)}</div>` : '') +
        `</div>`;
    }
    if (b.type === 'image_band') {
      // THE OFFICE'S OWN URL, AND ONLY AN ABSOLUTE OR ROOT-RELATIVE ONE. This
      // is the single block whose content is a link rather than text, so it is
      // the single place a stored value could point anywhere; anything that is
      // not plainly this site's or a data: URI is dropped rather than rendered.
      const u = String(b.url || '');
      if (!/^(https:\/\/|\/(?!\/)|data:image\/)/i.test(u)) return '';
      return `<div class="pb-band ${esc(b.ratio)}"><div class="pb-band-f">` +
        `<img src="${esc(u)}" alt="" loading="lazy" decoding="async"></div>` +
        ((b.caption.en || b.caption.cn) ? `<div class="pb-band-cap">${p2(b.caption)}</div>` : '') +
        `</div>`;
    }
    if (b.type === 'recipe_steps') {
      return head(b.head) + b.steps.map((st, i) =>
        `<div class="pb-step${i === 0 ? ' first' : ''}">` +
        `<div class="pb-step-n">${esc(String(i + 1).padStart(2, '0'))}</div>` +
        `<div class="pb-step-b"><div class="pb-step-t">${p2(st.text)}</div>` +
        ((st.time.en || st.time.cn) ? `<div class="pb-step-time">${p2(st.time)}</div>` : '') +
        `</div></div>`).join('');
    }
    if (b.type === 'pairings') {
      /* ONLY PRODUCTS THIS SHOP ACTUALLY LISTS. The tile's photo comes from
         this menu's own image route, and that route gates on shop_listings —
         so a pairing the operator has not put on this menu would render as a
         broken frame beside a name. Filtered rather than 404-ing, and the
         block disappears when nothing survives. The tiles do not navigate:
         the QR menu has no product URLs to navigate to, and a tile that looks
         tappable and is not would be worse than one that plainly is not. */
      const live = b.items.filter(x => listed && listed.has(x.id));
      if (!live.length) return '';
      return head(b.head) + `<div class="pb-pair">` + live.map(x =>
        `<div class="pb-pair-t"><div class="pb-pair-f">` +
        `<img src="/s/${esc(code)}/i/${x.id}?w=${MENU_THUMB_W}" alt="" loading="lazy" decoding="async">` +
        `</div><div class="pb-pair-n">${p2(x.name)}</div></div>`).join('') + `</div>`;
    }
    if (b.type === 'faq') {
      /* details/summary, NOT a tap handler. The mini app's accordion needs
         script; this opens with none at all, answers a keyboard, and is read
         correctly aloud. The first question opens, as it does there. */
      return head(b.head) + b.items.map((q, i) =>
        `<details class="pb-faq"${i === 0 ? ' open' : ''}>` +
        `<summary><span class="pb-faq-q">${p2(q.q)}</span>` +
        `<span class="pb-faq-m"><span class="l-plus">+</span>` +
        `<span class="l-minus">–</span></span></summary>` +
        `<div class="pb-faq-a">${p2(q.a)}</div></details>`).join('');
    }
    if (b.type === 'nutrition_facts') return nutCard(b.head, b.basis, nutRows(b.rows));
    return '';
  };

  /* §179 · THE SIGNATURE AT THE FOOT OF THE PAGE, which this menu never drew.
     §132 brought all thirteen of the office's BLOCKS here on Ash's "same as the
     mini app", and the colophon is not one of them -- it is three columns on the
     product row over the shop's own signature -- so a rule written about blocks
     could not see it. The phone drew it, the editor's preview drew it, and the
     one surface a customer actually scans at a counter drew nothing. Reported by
     Ash against a new product: the preview showed a character, the menu did not.

     IT NEVER OPENS A SHEET BY ITSELF, and that is the load-bearing half of this.
     §120's rule -- a product with nothing to say does not open, because an empty
     panel is worse than a card that does not respond -- is tested ABOVE, against
     the blocks, the nutrition and the sizes, and every line below runs after it.
     Built any earlier, EVERY product on EVERY menu would have become tappable
     onto a panel holding a mascot and the shop's own name, which is precisely
     the empty sheet that rule exists to refuse.

     NOTHING IS MAPPED HERE. The character comes back from lib/brand-signature:
     an override the office picked wins, an AUTO pick can only ever be a
     character this shop HAS, and a shop with no cast draws none. A second copy
     of Roots' category map on a third surface is the exact fault §158 exists to
     have ended, and writing one here would have re-opened it. */
  const rawKey = brandSignature.resolveCharacter(sig || {}, it.colophon_character, it.category);
  /* THE KEY BECOMES A FILENAME AND A PUBLIC URL, so it is held to a filename's
     alphabet at this one edge. resolveCharacter honours an operator's override
     verbatim by design -- that is its rule and the right one, since blanking a
     page somebody deliberately signed is worse -- but the mini app spends that
     value inside its own package and this page spends it inside an attribute on
     a page anyone can scan. Anything outside the cast's alphabet is not a
     character this shop has, and is simply not drawn. */
  const ipKey = /^[a-z0-9-]{1,40}$/.test(String(rawKey || '')) ? String(rawKey) : '';
  /* THE TAGLINE, PER LANGUAGE, exactly as the phone resolves it: the product's
     own override first; failing that the OTHER language, so an office that
     filled only one half still reads in both views; and only then the shop's
     house line. BOTH halves are emitted and CSS picks, because that is what
     this page is -- the phone picks one because it knows which one it is in. */
  const ovEn = String(it.colophon_tagline_en || '').trim();
  const ovCn = String(it.colophon_tagline_cn || '').trim();
  const coloTag = bi(ovEn || ovCn || String((sig && sig.tagline_en) || ''),
                     ovCn || ovEn || String((sig && sig.tagline_cn) || ''));
  /* The name on the hairline rule is the shop's own and is NOT bilingual: a
     tenant has one name. Empty for a tenant that carries none -- a rule reading
     "undefined" is worse than a rule with nothing on it (lib/brand-signature). */
  const coloHouse = String((sig && sig.house) || '').trim();
  /* Nothing to sign with, no slab. Three empty elements and two hairlines is
     not a colophon -- the mini app's own test, in its own words. */
  const colophon = (ipKey || coloTag || coloHouse)
    ? `<div class="pb-colo">` +
      (ipKey
        ? `<div class="pb-colo-ch"><img src="/assets/brand/ip-${ipKey}.jpg" alt=""` +
          ` loading="lazy" decoding="async"></div>`
        : '') +
      (coloTag ? `<div class="pb-colo-t">${coloTag}</div>` : '') +
      (coloHouse
        ? `<div class="pb-colo-m"><span class="pb-colo-r"></span>` +
          `<span>${esc(coloHouse)}</span><span class="pb-colo-r"></span></div>`
        : '') +
      `</div>`
    : '';

  return `<div class="dt-top">` +
      (it.has_photo
        ? `<button type="button" class="dt-ph" data-big="${it.store_product_id}"` +
          ` data-v="${esc(it.updated_at || '')}" aria-label="${esc('Enlarge 放大')}">` +
          `<img src="/s/${esc(code)}/i/${it.store_product_id}` +
          `?v=${encodeURIComponent(it.updated_at || '')}&w=${HERO_W}" alt="" loading="lazy" decoding="async">` +
          `</button>`
        : `<div class="dt-ph empty"></div>`) +
      `<div class="dt-hd"><div class="dt-nm">${bi(it.name_en, it.name_cn)}</div></div>` +
    `</div>` +
    /* EACH BLOCK IN ITS OWN BAND. The wrapper is what .pb spaces and
       rules against its neighbour; see the CSS for why the blocks could not
       simply keep their own margins. AN EMPTY BLOCK STAYS EMPTY: one() returns
       '' for a type it does not draw and for a pairings block whose products
       this shop no longer lists, and wrapping that would draw a rule and 52u of
       air around nothing — the blank band being exactly what a customer would
       read as a missing section. */
    blocks.map(b => band(one(b))).join('') +
    /* THE NUTRITION COLUMN COMES LAST, AND ONLY WHEN NO BLOCK ALREADY SAID IT.
       retail_products.nutrition is a separate column from the nutrition_facts
       block and most products use one or the other; a product carrying both
       would otherwise print its table twice under the same heading. */
    /* …and only when the office did not write a nutrition BLOCK at all. The
       question is put to the unfiltered source (blockRead.hasNutritionBlock),
       not to `blocks`: a nutrition block the office has switched off for this
       page is absent from `blocks`, and reading the absence as "no block" is
       how a hidden table would have printed here anyway, out of the column. */
    (nut && !blockRead.hasNutritionBlock(it.description_blocks)
      ? band(nutCard({ en: 'Nutrition', cn: '营养成分' },
                { en: nut.basis_en || '', cn: nut.basis_cn || '' },
                nutRows(nut.rows.map(r => ({
                  label: { en: r.label_en || '', cn: r.label_cn || '' },
                  value: r.value, kind: r.kind,
                })))))
      : '') +
    /* LAST, UNDER EVERYTHING, which is where a signature goes. */
    colophon;
}
// EN / 中 — the storefront's own toggle labels, reused verbatim.
function toggle(lang) {
  return `<div class="lang">` +
    `<button type="button" data-lang="en"${lang === 'en' ? ' class="on"' : ''}>EN</button>` +
    `<button type="button" data-lang="cn"${lang === 'cn' ? ' class="on"' : ''}>中</button>` +
    `</div>`;
}

function shell({ lang, hasParam, title, vars, faces, body }) {
  return `<!doctype html><html lang="${lang === 'cn' ? 'zh-CN' : 'en'}" class="lang-${lang}"><head>
<meta charset="utf-8">
<meta name="viewport" content="${VIEWPORT}">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>${styles(vars, faces)}</style>
<script>${langScript(hasParam)}</script>
</head><body>
${body}
<script>${TOGGLE_SCRIPT}</script>
</body></html>`;
}

// THE NOT-FOUND PAGE IS THE EMPTY-MENU PAGE, AND THAT IS DELIBERATE.
//
// A code that resolves to nothing, a shop switched off and a location switched
// off all return these same bytes with a 404. Two reasons, and the second is
// the load-bearing one:
//
//   1. There is no live or locked Chinese source for "that code is not a
//      shop", and §30 forbids composing one. The empty-menu pair IS live.
//
//   2. THE PAGE MUST NOT BE AN ORACLE FOR GUESSED CODES. The shop code is the
//      whole of what stands between one shop's menu and prices — in a
//      multi-tenant deployment, one tenant's and another's — and anybody
//      editing the address bar (lib/shop-code.js says the same). A reply that
//      distinguished "no such code" from "shop closed" would confirm which
//      guesses had hit a real shop. Customers scan; they never type a code, so
//      telling apart a wrong code and an empty menu buys a real customer
//      nothing and buys a guesser a great deal.
function notFoundPage(req, res) {
  const { vars, fonts } = themeBits();
  const lang = req.query.lang === 'cn' ? 'cn' : 'en';
  const brand = brandText();
  // Never cached: a code that resolves to nothing today may be a live shop
  // tomorrow, and an intermediary holding this 404 would outlast the fix.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.status(404).type('html').send(shell({
    lang, hasParam: req.query.lang === 'cn' || req.query.lang === 'en',
    title: brand, vars, faces: fontFaces(fonts),
    body: `<div class="bar">${toggle(lang)}</div>
<div class="empty"><div class="t">${bi('No products yet.', '暂无商品')}</div>` +
      `<div class="s">${bi('Check back soon.', '请稍后再来')}</div></div>`,
  }));
}

// ─── in-page WeChat payment (§50) ───────────────────────────────────────
//
// OFF UNLESS THE OFFICIAL ACCOUNT IS CONFIGURED, and that is the deploy story
// rather than a nicety: with WECHAT_OA_APP_ID / WECHAT_OA_APP_SECRET unset —
// which is every environment until somebody sets them — every branch below is
// dead and this page behaves exactly as §44 shipped it. Nothing to roll back
// and nothing to gate; the credentials ARE the switch.
//
// Pay's own devMode is checked too. An Official Account with no merchant behind
// it can obtain an openid and then fail at the charge, which would strand a
// customer mid-payment on a screen offering them nothing else.
//
// AND THE RAIL IS OFF UNTIL THE DOMAIN IS ICP-FILED — Ash, 2026-09-08. JSAPI
// charges only on a domain registered as a payment directory in the merchant
// platform, and WeChat does not accept a domain onto that list without an ICP
// filing. shop.rootskitchenchina.com has none, so every charge this rail raised
// failed at WeChat rather than in our code: the page was offering a payment it
// could never take, which is worse than offering none. Every QR order is a
// counter order until the filing lands.
//
// A SWITCH RATHER THAN A DELETION, and rather than unsetting the OA credentials
// on the box. §50's machinery is correct and still tested — what is missing is
// a filing, not code — so it stays in the tree behind one flag. Unsetting the
// credentials would have done the same job here and silently taken out
// everything else the Official Account is used for; this reaches only the rail
// it names. Set SHOP_QR_WECHAT_PAY=1 to turn it back on.
function wxRailEnabled() {
  return process.env.SHOP_QR_WECHAT_PAY === '1';
}

function oaReady() {
  if (!wxRailEnabled()) return false;
  try {
    const p = oaPayContext();
    return !p.oaDevMode && !p.devMode;
  } catch (e) { return false; }
}

// The OAuth `state`, bound to the order it was issued for.
//
// There is no session and no cookie on this page (§44), so state cannot be
// stored and compared — it is DERIVED instead, as an HMAC of the pay token
// under a key only this server holds. A code returned against a state that
// does not recompute was not obtained through our redirect for this order, and
// is refused. The Official Account secret is the key because it is already
// server-only and already required for the exchange that follows.
function payState(token) {
  const p = oaPayContext();
  const key = p.appId + '|' + String(p.oaAppSecret || '');
  return crypto.createHmac('sha256', key).update(String(token)).digest('hex').slice(0, 32);
}

// Is this WeChat's own browser?
//
// THIS IS NOT THE BRANCH §47 KEEPS OFF THE MENU, and the distinction is worth
// stating because the two look identical from a distance. §47's rule — held by
// a test that fetches the menu under three user agents and compares the bytes —
// is that WHAT A SHOP SELLS never depends on what someone is reading it with.
// This is a different page and a different question: WeChat's in-page payment
// physically cannot run outside WeChat, and §50's second ruling says the
// customer who is outside it pays at the counter. Answering that needs knowing,
// and the alternative is worse than knowing — sending them to an authorize URL
// that cannot complete strands them on WeChat's own error page, which is the
// one outcome §50 says this page must never produce.
//
// It is used ONLY to choose between offering the payment sheet and showing the
// counter screen. Nothing about the order, the prices or the menu moves on it.
function inWeChat(req) {
  return /MicroMessenger/i.test(String(req.get('user-agent') || ''));
}

// The absolute URL WeChat redirects back to. It must match the domain
// registered against the Official Account, so it is built from the request's
// own host rather than from config — the page is already being served from
// that domain or the customer would not be reading it.
function payReturnUrl(req, code, token) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${req.get('host')}/s/${code}/pay/${token}`;
}

// ─── routes ─────────────────────────────────────────────────────────────

router.get('/s/:shopCode', (req, res) => {
  const code = String(req.params.shopCode || '');
  // Refused before it can become a query — lib/shop-code.js asks for exactly
  // this, so a malformed path never reaches the database.
  if (!isShopCode(code)) return notFoundPage(req, res);
  const shop = resolveShop(code);
  if (!shop) return notFoundPage(req, res);

  const { vars, fonts } = themeBits();
  const lang = req.query.lang === 'cn' ? 'cn' : 'en';
  const hasParam = req.query.lang === 'cn' || req.query.lang === 'en';
  const cur = normalizeCurrency(cfg('currency', null));
  const name = shopName(shop);
  const groups = buildMenu(shop);
  /* §132 — WHAT THIS SHOP ACTUALLY LISTS, for the pairings block alone. Its
     tiles draw their photo from this menu's own image route, and that route
     gates on shop_listings: a pairing the operator has not put on THIS menu
     would render as a broken frame beside a name. Built once from the menu that
     was just assembled rather than queried again, so the two can never disagree
     about what is on it — including the variant siblings, which the collapse
     folds into one card but which remain separately listed and separately
     servable. */
  const listed = new Set();
  for (const c of groups) {
    for (const sec of c.sections) {
      for (const r of sec.items) {
        listed.add(r.store_product_id);
        if (r.variants) for (const m of r.variants) listed.add(m.store_product_id);
      }
    }
  }
  const wxPay = oaReady();
  const brand = brandText();
  /* §179 — ONCE PER REQUEST, not once per card. Every product on this menu is
     signed by the same shop, and a per-card lookup would put one identical
     query behind every tile on the page. */
  const sig = menuSignature(req);
  /* §228 — THE BLOCK TYPES THIS TENANT'S COUNTER MENU MAY DRAW, read here for
     the same reason as the signature: one row, identical for every product on
     the page. It is an ALLOW-LIST: a type absent from it does not draw unless
     the block itself says so. Absent config means the seed in
     lib/qr-menu-block-defaults — the eight Quinoa Salad shows. */
  const qrShown = qrBlockDefaults.readShownTypes(tdb());

  const head = `<div class="bar"><div class="nm">${bi(name.en, name.cn)}</div>${toggle(lang)}</div>`;

  // The rail: ALL, every category holding something, then OTHER. Anchors, not
  // tabs — a menu is short enough to scroll, and an anchor needs no state and
  // no script to work. ALL / 全部 and OTHER / 其他 are the shop's own labels.
  const rail = groups.length
    ? `<nav class="rail"><a href="#top" data-cat="top" class="on">` +
      // ALL WEARS THE SAME THREE PARTS AS EVERY OTHER TAB, and the empty .cv is
      // the reason: the label only centres because it is the flex:1 child
      // between two 9px spacers. ALL had neither, so its text sat hard against
      // the left spacer while every category below it was centred. There is no
      // chevron in it — ALL is the top of the list, not a jump into one — but
      // the width it would occupy is still held, or the centring is a lie.
      `<span class="lb">${bi('ALL', '全部')}</span><span class="cv"></span></a>` +
      groups.map(c => `<a href="#${c.id}" data-cat="${c.id}">` +
        `<span class="lb">${bi(c.en, noOrphanAmp(c.cn))}</span><span class="cv">\u203a</span></a>`).join('') +
      `</nav>`
    : '';

  const card = (it) => {
    const src = `/s/${esc(code)}/i/${it.store_product_id}` +
      `?v=${encodeURIComponent(it.updated_at || '')}&w=${MENU_THUMB_W}`;
    // No photo → the empty frame, never an <img> that cannot resolve. A
    // product nobody has photographed is ordinary; a broken-image glyph beside
    // its name reads as a fault in the shop.
    const photo = it.has_photo
      ? `<img src="${src}" alt="" loading="lazy" decoding="async">`
      : '';
    // A SOLD-OUT CARD GETS NO ADD BUTTON AT ALL, rather than a disabled one.
    // The sold-out bar already says why, and a greyed control beside it invites
    // a tap that has to be refused — the availability is re-checked at submit
    // anyway (§47), so this is the honest half of the same answer, not the
    // whole of it.
    // THE ADD BUTTON SITS BESIDE THE PRICE, NOT ON THE PHOTO. It was on the
    // photo's corner first, and that was wrong twice over: it covered the
    // product it was offering to add, and it is not where this shop's own
    // customers already look for it — the mini app puts it on the price row,
    // and a customer who knows the app should not have to learn a second place.
    //
    // THE BUTTON SAYS WHETHER IT ADDS OR ASKS. A product with questions on it
    // opens the picker instead of dropping straight into the basket, and the
    // script needs to know which before the tap — `data-ask` is that flag, so
    // the decision is made from the DOM rather than by looking the product up
    // in a map that may not have been built yet.
    /* ONE ADD BUTTON PER PURCHASABLE THING, and for a collapsed card that means
       one per size, hidden. §120 built a single add path on purpose — the sheet
       adds by clicking the card's own + , so the basket cannot learn a second
       way to be wrong — and §129's size picker keeps it: choosing a size clicks
       that sibling's own button. The alternative was a second addLine caller
       that would have had to re-derive the price, the name and whether that
       size asks questions, which is three chances to disagree with the first.
       A SOLD-OUT SIZE STILL GETS ITS BUTTON, because the picker has to draw it
       greyed and say so (§120 rule 1A's shape); it is inside a [hidden]
       wrapper, so no thumb can reach it and the picker refuses it anyway. */
    const addBtn = (m, extra) =>
      `<button type="button" class="add" data-add="${m.store_product_id}"` +
      ` data-p="${esc(String(Number(m.price) || 0))}"` +
      (m.options ? ` data-ask="1"` : '') +
      (m.sold_out ? ` data-out="1"` : '') +
      ` data-en="${esc(m.name_en || '')}" data-cn="${esc(m.name_cn || '')}"` +
      ` data-vl-en="${esc(m.variant_label || '')}" data-vl-cn="${esc(m.variant_label_cn || m.variant_label || '')}"` +
      (extra || '') +
      ` aria-label="${esc(m.name_en || m.name_cn || '')}">+</button>`;
    const vs = it.variants && it.variants.length > 1 ? it.variants : null;
    // A collapsed card's visible + does NOT add anything: it offers the sizes,
    // exactly as the mini app's grid does. data-sizes is the flag, read from
    // the DOM before the tap for the same reason data-ask is.
    const add = it.sold_out ? '' : (vs
      ? `<button type="button" class="add" data-sizes="1"` +
        ` data-en="${esc(it.name_en || '')}" data-cn="${esc(it.name_cn || '')}"` +
        ` aria-label="${esc(it.name_en || it.name_cn || '')}">+</button>`
      : addBtn(it));
    const vadds = vs
      ? `<div class="vadds" hidden>${vs.map(m => addBtn(m)).join('')}</div>`
      : '';
    // THE QUESTIONS RIDE WITH THE CARD, as JSON in a <template>, for the same
    // reason the detail sheet's body does: this page renders in ONE response
    // and a fetch-then-render picker would put a blank sheet in front of a
    // customer who has just tapped. Escaped with the page's own esc(), and read
    // back through .content.textContent, which decodes it — so a product named
    // with an & or a < cannot close the template early.
    /* ONE TEMPLATE PER PURCHASABLE THING, for the same reason as the buttons.
       §129: a collapsed card is several products, and each size carries its
       OWN questions — a 250g jar can ask something the 500g does not. Emitting
       only the representative's would mean choosing the other size and being
       asked the representative's questions, or none at all. */
    const optTpl = (m) => m.options
      ? `<template data-op="${m.store_product_id}">${esc(JSON.stringify(m.options))}</template>`
      : '';
    const optJson = vs ? vs.map(optTpl).join('') : optTpl(it);
    // TAPPABLE ONLY WHERE THERE IS SOMETHING TO READ. A product with no
    // ingredients, no nutrition and no allergen flags opens a sheet saying
    // nothing, which is worse than a card that does not respond — so the whole
    // detail apparatus is absent for it rather than empty.
    const detail = detailBody(it, code, listed, sig, qrShown);
    const tap = detail
      ? ` data-open="${it.store_product_id}" role="button" tabindex="0"` : '';
    return `<div class="it${it.sold_out ? ' out' : ''}${detail ? ' has-dt' : ''}"${tap}>` +
      vadds +
      (detail ? `<template data-dt="${it.store_product_id}">${detail}</template>` : '') +
      optJson +
      `<div class="ph">${photo}` +
      (it.sold_out ? `<div class="sold">${bi('Sold out', '售罄')}</div>` : '') +
      `</div>` +
      `<div class="t">${bi(it.name_en, it.name_cn)}</div>` +
      `<div class="pf"><div class="pr">${esc(money(it.price, cur))}</div>${add}</div>` +
      `</div>`;
  };

  // The launch state. shops and shop_listings are both empty, so this is the
  // first thing anybody will see and it is a first-class state, not an edge
  // case. Strings are the storefront's own, live.
  // ── THE CART (§44) ────────────────────────────────────────────────────
  //
  // IT LIVES IN MEMORY AND NOWHERE ELSE. No cookie, no localStorage, no
  // session — the brief's constraint, and right on its own terms: a customer
  // standing at a counter has one order, and a basket that survived a reload
  // would be a stale order from an earlier visit waiting to be submitted by
  // accident. Losing it on refresh is the correct behaviour, not a limitation.
  //
  // EVERY STRING HERE IS COPIED FROM THE LIVE STOREFRONT, not composed. The
  // customer who buys online and the customer standing in the shop are the same
  // person and should meet the same words. Sources are named against each pair
  // in docs/tacet-delivery-vocabulary.md; the two that had no live source are
  // marked there as composed.
  const cartUi = groups.length ? (
    // The bar. Hidden until something is in the basket — an empty bar is a
    // permanent strip of chrome over the menu it exists to serve.
    // data-wxpay carries the ONE per-request fact the basket script needs about
    // payment, on the same reasoning as the currency attributes beside it: the
    // script is built once at module load and this is resolved per request.
    // Note what it is NOT — it says whether this SHOP can take an in-page
    // WeChat payment, never anything about the browser reading it. §47's rule
    // that nothing on this page branches on the user agent is untouched, and
    // its test still compares these bytes across three of them.
    `<div class="cbar" id="cbar" hidden data-sym="${esc(cur.symbol)}"` +
      ` data-dec="${esc(String(cur.decimals))}" data-pos="${esc(cur.position)}"` +
      `${wxPay ? ' data-wxpay="1"' : ''}>` +
      `<button type="button" class="cbar-b" id="cbarOpen">` +
        `<span class="cbar-n" id="cbarN">0</span>` +
        `<span class="cbar-l" id="cbarL">${bi('YOUR BASKET', '购物车')}</span>` +
        `<span class="cbar-v" id="cbarV"></span>` +
      `</button>` +
    `</div>` +
    // The sheet. One panel, three faces — basket, then the placed order, then
    // the refusal — so the customer never loses their place on the menu behind
    // it.
    // The product sheet. A second panel rather than a second face of the basket
    // one: a customer reading a label has not decided to order yet, and putting
    // the two in one element would mean closing their basket to read a card.
    `<div class="sheet" id="dsheet" hidden>` +
      `<div class="sheet-bg" id="dsheetBg"></div>` +
      `<div class="sheet-p" role="dialog" aria-modal="true">` +
        `<div class="sheet-h">` +
          `<div class="sheet-t" id="dsheetT"></div>` +
          `<button type="button" class="sheet-x" id="dsheetX" aria-label="${esc('Cancel 取消')}">` +
          `<span class="xb xb1"></span><span class="xb xb2"></span></button>` +
        `</div>` +
        `<div class="sheet-b" id="dsheetB"></div>` +
        `<div class="sheet-f">` +
          `<div class="tot"><span id="dPr"></span>` +
          /* BOTH LABELS SHIP, AND THE SCRIPT SWAPS WHICH IS SHOWN (§129). The
             button says ADD TO BASKET for a plain product and CHOOSE A SIZE for
             one with siblings — the mini app's own two states for this control.
             They are rendered here rather than assigned from a constant for a
             reason that cost a round: the script's label constants live inside
             the BASKET's closure, and this button is driven from the product
             page's, which cannot see them. Rendering the pair server-side also
             keeps both languages in the DOM, so the page's CSS switch goes on
             working on a label the script changed. */
          `<button type="button" class="place dadd" id="dAdd">` +
            `<span class="dadd-a">${bi('ADD TO BASKET', '加入购物车')}</span>` +
            `<span class="dadd-s" hidden>${bi('CHOOSE A SIZE', '选择规格')}</span>` +
          `</button>` +
          `</div>` +
        `</div>` +
      `</div>` +
    `</div>` +
    // The enlarge. Outside both sheets so it can sit over either.
    // A REAL BUTTON, AND A LISTENER ON THE OVERLAY ITSELF. The first version
    // closed on a document-level tap and nothing else: it passed in headless
    // Chromium and did not work on the phone, where the customer was left with
    // a full-screen photo and no way out but leaving the menu. Reported from
    // a phone. A delegated tap on a non-interactive full-screen div is not
    // something to rely on in a WeChat web view; a button is.
    `<div class="big" id="big" hidden>` +
      `<button type="button" class="big-x" id="bigX" aria-label="${esc('Close 关闭')}">` +
      `<span class="xb xb1"></span><span class="xb xb2"></span></button>` +
      `<img id="bigImg" src="" alt="">` +
    `</div>` +
    `<div class="sheet" id="sheet" hidden>` +
      `<div class="sheet-bg" id="sheetBg"></div>` +
      `<div class="sheet-p" role="dialog" aria-modal="true">` +
        `<div class="sheet-h">` +
          // NAMED, BECAUSE THE PANEL HAS MORE THAN ONE FACE. It is the basket,
          // and it is also the list of orders this phone has placed — the
          // heading is repainted with the face rather than lying about one of
          // them. THAT INCLUDES BEING REPAINTED EMPTY: the placed order names
          // itself in its own body and clears this, which is a face setting
          // the heading, not a face forgetting to. A face that leaves it alone
          // is a face wearing the last one's word; done() carried YOUR BASKET
          // over a placed order for exactly that reason.
          `<div class="sheet-ht">` +
            `<div class="sheet-t" id="sheetT">${bi('YOUR BASKET', '购物车')}</div>` +
            // THE PRODUCT BEING ASKED ABOUT, and only the picker wears it. The
            // basket, the orders list and the placed order all name themselves
            // in the heading above; the picker's heading is the same four words
            // every time, so the name has to go somewhere and this is it. Empty
            // and [hidden] for every other face, cleared by pkClose the way
            // every other face-specific part of this panel is.
            `<div class="sheet-n" id="sheetN" hidden></div>` +
          `</div>` +
          // AN ATTRIBUTE TAKES TEXT, NOT MARKUP. bi() returns two <span>s, and
          // putting that in aria-label closed the attribute at its first quote
          // and spilled the rest into the header as visible text — a stray
          // "Cancel" box beside the ×, reported from a phone. Both languages go
          // in as one plain escaped string: an accessibility label is read out,
          // never laid out, so it has no CSS switch to obey.
          `<button type="button" class="sheet-x" id="sheetX" aria-label="${esc('Cancel 取消')}">` +
          `<span class="xb xb1"></span><span class="xb xb2"></span></button>` +
        `</div>` +
        `<div class="sheet-b" id="sheetB"></div>` +
        `<div class="sheet-f" id="sheetF">` +
          `<div class="tot"><span>${bi('Total', '合计')}</span><span id="cTot"></span></div>` +
          `<label class="nm-l" for="cName">${bi('Name', '姓名')}</label>` +
          `<input class="nm-i" id="cName" type="text" maxlength="40" autocomplete="name"` +
            ` enterkeyhint="done" inputmode="text">` +
          `<div class="err" id="cErr" hidden></div>` +
          // Asked before the order exists, because §50's print rule turns on the
          // answer. WeChat leads: it is the path that saves the queue, and the
          // customer who is going to walk to the till is the one already
          // expecting to do something.
          (wxPay
            ? `<div class="pw" id="cPw">` +
                `<button type="button" data-pm="wechat" class="on">${bi('WeChat Pay', '微信支付')}</button>` +
                `<button type="button" data-pm="counter">${bi('Pay at the counter', '收银台付款')}</button>` +
              `</div>`
            : '') +
          `<button type="button" class="place" id="cPlace">${bi('Place order →', '提交订单 →')}</button>` +
        `</div>` +
        // THE PICKER'S OWN FOOT, because the basket's foot asks for a name and
        // a tender and the picker asks for neither. One foot serving both would
        // be a name field over a sugar level.
        //
        // THE BUTTON CARRIES THE RUNNING PRICE, base plus whatever is ticked,
        // so the customer sees what the extra costs before they commit to it
        // rather than discovering it in the basket. Same treatment the mini
        // app's own option sheet gives it.
        `<div class="sheet-f" id="sheetO" hidden>` +
          `<div class="err" id="oErr" hidden></div>` +
          `<button type="button" class="place" id="oAdd"></button>` +
        `</div>` +
      `</div>` +
    `</div>`
  ) : '';

  const body = groups.length
    ? `<div class="wrap">${rail}<div class="pane">` +
      groups.map(c => `<section class="cat" id="${c.id}">` +
        c.sections.map(sec => `<div class="sec-h">` +
            `<div class="kick">${bi(sec.en, sec.cn)}</div>` +
            `<div class="cnt">${pad2(sec.items.length)}</div>` +
          `</div><div class="grid">${sec.items.map(card).join('')}</div>`).join('') +
        `</section>`).join('') +
      `</div></div>` + cartUi
    : `<div class="empty"><div class="t">${bi('No products yet.', '暂无商品')}</div>` +
      `<div class="s">${bi('Check back soon.', '请稍后再来')}</div></div>`;

  // A menu is priced and stocked; it must never be served from an
  // intermediary's cache. The shop code is also not something to index.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.type('html').send(shell({
    lang, hasParam,
    title: [name.en || name.cn, brand].filter(Boolean).join(' · '),
    vars, faces: fontFaces(fonts), body: `<a id="top"></a>` + head + body,
  }));
});

// A menu photo.
//
// GATED ON "LISTED AT AN ACTIVE SHOP", NOT ON is_published — ruled 2026-09-06.
// is_published governs the ONLINE STORE; a shop listing governs the SHOP. They
// are different questions and tying them would mean a product could be on a
// counter menu with its photo refused, purely because nobody had also chosen
// to sell it on the website. The public storefront twin of this route
// (routes/retail.js, /api/retail/products/:id/image) keeps its own
// is_published gate and is unchanged.
const PHOTO_CACHE = new Map();
const PHOTO_CACHE_MAX = 300;

router.get('/s/:shopCode/i/:productId', async (req, res) => {
  const code = String(req.params.shopCode || '');
  const id = parseInt(req.params.productId, 10);
  if (!isShopCode(code) || !Number.isFinite(id) || id <= 0) return res.status(404).end();

  let w = parseInt(req.query.w, 10);
  w = (sharp && Number.isFinite(w)) ? Math.max(80, Math.min(1200, w)) : 0;
  const ver = String(req.query.v || '');

  let tkey = 'default';
  try { tkey = tdb().name || 'default'; } catch (e) { /* no tenant scope on this request; the default key is correct, not a fallback */ }
  const ckey = `${tkey}|${code}|${id}|w${w || 0}|${ver}`;
  const hit = PHOTO_CACHE.get(ckey);
  if (hit) {
    res.set('Content-Type', hit.mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(hit.buf);
  }

  const gate = tdb().prepare(`
    SELECT 1 FROM shop_listings sl
      JOIN shops s          ON s.id = sl.shop_id
      JOIN retail_stores l  ON l.id = s.location_id
     WHERE s.public_code = ? AND sl.store_product_id = ?
       AND s.is_active = 1 AND COALESCE(l.is_active, 1) = 1
  `).get(code, id);
  const data = gate && resolveProductImage(id);
  if (!data) return res.status(404).end();

  const m = /^data:([^;,]*?)(;base64)?,([\s\S]*)$/.exec(data);
  if (!m) return res.redirect(String(data));
  const mime = m[1] || 'application/octet-stream';
  let buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  let outMime = mime;
  if (w && /^image\//i.test(mime) && !/svg/i.test(mime)) {
    try {
      let pipe = sharp(buf).resize({ width: w, withoutEnlargement: true });
      if (/jpe?g/i.test(mime))    pipe = pipe.jpeg({ quality: 72, mozjpeg: true });
      else if (/png/i.test(mime)) pipe = pipe.png({ compressionLevel: 9, palette: true });
      const out = await pipe.toBuffer({ resolveWithObject: true });
      buf = out.data;
      outMime = 'image/' + out.info.format;
    } catch (e) { /* keep the original bytes */ }
  }
  if (PHOTO_CACHE.size >= PHOTO_CACHE_MAX) PHOTO_CACHE.delete(PHOTO_CACHE.keys().next().value);
  PHOTO_CACHE.set(ckey, { buf, mime: outMime });
  res.set('Content-Type', outMime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(buf);
});

// ─── Submitting an order — §44, §45 ─────────────────────────────────────

// THIS IS A PUBLIC, UNAUTHENTICATED WRITE, and it is the only one this module
// has. §44 designs it that way on purpose: no login, no phone number, no
// account, because the customer is standing in the shop and every field asked
// for is friction at the point of highest abandonment. The cost of that choice
// is that anyone who can see the QR can post here, so the guards below are the
// whole of what stands between a shop and a printer full of nonsense.
//
// THE STAFF-ACCEPT STEP IS A PRINT GATE, NOT A STATUS, and it belongs with the
// printing rather than here. §44 places it "between submit and print": the
// order EXISTS either way, and what waits for a human is the ticket. An earlier
// draft of this handler invented a `pending_accept` status, which no screen, no
// sweep and no report in this repo understands — an order in it would have been
// invisible in the admin and untouched by the twenty-minute counter clock. A
// QR order is therefore an ordinary pending_payment order from the moment it is
// submitted, and the accept step arrives with the print trigger.
const ORDER_LIMIT = rateLimit({
  windowMs: 60 * 1000,
  max: 12,                    // a table of six ordering separately, twice over
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'too_many_orders' },
});

// Cancelling gets its OWN budget rather than sharing the one above. A hotel's
// whole floor is behind one IP, so a busy lunch can spend the ordering budget
// legitimately — and the moment that happens is exactly when somebody needs to
// undo a mistake. A cancel that fails because other people were ordering would
// be the worst possible time for this control not to work.
const CANCEL_LIMIT = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'too_many_requests' },
});

const MAX_LINES = 40;         // a menu is not a wholesale order form
const MAX_QTY = 20;           // per line
// Answers per line (§120). A drink with more than a dozen ticked extras is a
// post nobody made from the picker, and the cap is here so a hand-rolled body
// cannot make the validation loop do unbounded lookups.
const MAX_CHOICES = 12;

router.post('/s/:shopCode/order', ORDER_LIMIT, express.json({ limit: '32kb' }), (req, res) => {
  const code = String(req.params.shopCode || '');
  if (!isShopCode(code)) return res.status(404).json({ success: false, error: 'not_found' });
  const shop = resolveShop(code);
  if (!shop) return res.status(404).json({ success: false, error: 'not_found' });

  const b = req.body || {};
  // §44: "The customer selects from that shop's listings, supplies a name, and
  // submits." A name and nothing else — it is what gets called across a room.
  // The angle brackets go the same way they go out of the injected CSS above:
  // this name is printed into lib/feie.js's slip markup, whose <CB>/<BOLD> tags
  // are the same shape. A name is a name — nobody loses one to this — and it is
  // the only customer-supplied string on this whole path.
  const name = String(b.name == null ? '' : b.name).replace(/[<>]/g, '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ success: false, error: 'name_required' });

  // HOW THEY MEAN TO PAY — and it is asked here, before the order exists,
  // because §50 hangs the kitchen ticket on the answer: an in-page WeChat order
  // prints when the money arrives, every other one prints now.
  //
  // 'wechat' is honoured ONLY when the shop can actually take it. A body
  // claiming 'wechat' at a shop with no Official Account configured falls back
  // to the counter rather than being refused — the customer gets the flow that
  // works instead of an error, and the ticket still prints on submit.
  const wantsWechat = String(b.pay_method || '') === 'wechat' && oaReady();

  const rawLines = Array.isArray(b.items) ? b.items : [];
  if (!rawLines.length) return res.status(400).json({ success: false, error: 'no_items' });
  if (rawLines.length > MAX_LINES) return res.status(400).json({ success: false, error: 'too_many_lines' });

  // PRICES ARE NEVER TAKEN FROM THE CLIENT. The browser sends product ids and
  // quantities; every price, every line total and the order total are read from
  // shop_listings here. A price posted by a customer is not a price.
  const listings = tdb().prepare(`
    SELECT sl.store_product_id AS pid, sl.price, sl.fulfilment_mode, sl.is_available,
           p.name_en, p.name_cn, p.sku, p.weight AS size,
           p.ship_modes, p.needs_ice_pack, p.ship_from_supplier
      FROM shop_listings sl
      JOIN store_products p ON p.id = sl.store_product_id
     WHERE sl.shop_id = ? AND COALESCE(p.is_active, 1) = 1
  `).all(shop.id);
  const byId = new Map(listings.map(r => [r.pid, r]));

  // ONE POSTED LINE IS ONE ROW, and since §120 two rows may share a product:
  // a full-sugar latte and a half-sugar latte are two things to make, two
  // prices and two lines on the ticket. `wanted` still aggregates by product
  // because the SHELF does not care which sugar level drew the cup down.
  const rows = [];
  const wanted = new Map();
  for (const raw of rawLines) {
    const pid = parseInt(raw && raw.store_product_id, 10);
    const qty = parseInt(raw && raw.qty, 10);
    if (!Number.isInteger(pid) || !byId.has(pid)) {
      return res.status(400).json({ success: false, error: 'not_on_this_menu', store_product_id: pid || null });
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      return res.status(400).json({ success: false, error: 'bad_qty', store_product_id: pid });
    }
    // The answers, as ids and nothing else. Everything they mean — the label,
    // the question, the price — is looked up from this tenant's own tables
    // below. A delta that arrived from a phone is not a delta.
    const rawCh = Array.isArray(raw && raw.choices) ? raw.choices : [];
    if (rawCh.length > MAX_CHOICES) {
      return res.status(400).json({ success: false, error: 'too_many_choices', store_product_id: pid });
    }
    const choices = [];
    for (const c of rawCh) {
      const cid = parseInt(c, 10);
      if (!Number.isInteger(cid) || cid < 1) {
        return res.status(400).json({ success: false, error: 'bad_choice', store_product_id: pid });
      }
      if (choices.indexOf(cid) < 0) choices.push(cid);
    }
    rows.push({ pid, qty, choices });
    wanted.set(pid, (wanted.get(pid) || 0) + qty);
  }

  // ── THE ANSWERS, CHECKED AGAINST THE QUESTIONS (§120; moved out in §183) ─
  // Every rule that used to be written out here — a choice belongs to the
  // product it was posted for, a single-answer question takes exactly one
  // answer, a pick-any group's floor and ceiling bind, a required question must
  // be answered, nothing is priced from the post body — now lives in
  // lib/product-options.js, and the counter till obeys the same copy. The rules
  // did not change; read the module header for why they moved.
  //
  // THE SHELF STAYS HERE, because WHOSE shelf is this shop's question and not a
  // rule about options. §47 governs the verdict as it governs everything else
  // on this shop's shelf: counted units at THIS location, absent record is
  // sold out.
  const orderedPids = [...wanted.keys()];
  const optAddonIds = [...new Set(tdb().prepare(
    `SELECT DISTINCT c.stock_product_id
       FROM retail_product_option_choices c
       JOIN retail_product_options o ON o.id = c.option_id
      WHERE o.product_id IN (${orderedPids.map(() => '?').join(',')})
        AND c.stock_product_id IS NOT NULL`
  ).all(...orderedPids).map(r => r.stock_product_id))];
  const optAddonAvail = optAddonIds.length
    ? inventory.getAvailableMap(shop.location_id, optAddonIds, SHOP_CHANNEL)
    : new Map();
  const isChoiceSoldOut = (c) => {
    const a = optAddonAvail.get(c.stock_product_id);
    return !a || a.available <= 0;          // absent shelf record IS sold out — §47
  };

  const answers = productOptions.resolveAnswers(
    tdb(), rows.map(r => ({ product_id: r.pid, qty: r.qty, choices: r.choices })),
    { isChoiceSoldOut }
  );
  if (answers.error) {
    return res.status(400).json({
      success: false, error: answers.error, store_product_id: answers.product_id || null,
    });
  }
  // Stock-backed extras add their own demand, one per unit bought, exactly as
  // the web checkout's expandStockLines has always counted them — aggregated by
  // the module, so three lattes each taking an oat milk ask the shelf for three.
  const addonWant = answers.addonWant;

  // AVAILABILITY IS RE-CHECKED AT SUBMIT, not trusted from the page the
  // customer has been reading. The menu they loaded may be minutes old and the
  // last one may have gone in between. Same two rules the page renders by:
  // made-here obeys its switch, stocked obeys the switch AND the shelf, and an
  // absent shelf record is sold out (§47).
  const stockedIds = [...wanted.keys()].filter(pid => byId.get(pid).fulfilment_mode === 'stocked');
  const avail = stockedIds.length
    ? inventory.getAvailableMap(shop.location_id, stockedIds, SHOP_CHANNEL)
    : new Map();
  const soldOut = [];
  for (const [pid, qty] of wanted) {
    const l = byId.get(pid);
    if (!l.is_available) { soldOut.push(pid); continue; }
    if (l.fulfilment_mode !== 'stocked') continue;
    const a = avail.get(pid);
    if (!a || a.available < qty) soldOut.push(pid);
  }

  // A CHOSEN EXTRA THAT HAS RUN OUT REFUSES THE LINE THAT CHOSE IT, and §47's
  // rule governs it as it governs everything else on this shop's shelf: counted
  // units at THIS location, absent record is sold out.
  //
  // THE REFUSAL NAMES THE MENU PRODUCT, NOT THE EXTRA, and that is the whole
  // reason this is a separate pass. The page answers a 409 by clearing that
  // product's lines from the basket so the customer can choose again; handed
  // an oat-milk id it would find nothing to clear and hand back the same order.
  // What has become unavailable is that latte AS CONFIGURED, and naming the
  // latte is what lets them re-pick.
  if (addonWant.size) {
    const addonAvail = inventory.getAvailableMap(shop.location_id, [...addonWant.keys()], SHOP_CHANNEL);
    const deadAddons = new Set();
    for (const [aid, need] of addonWant) {
      const a = addonAvail.get(aid);
      if (!a || a.available < need) deadAddons.add(aid);
    }
    if (deadAddons.size) {
      // Read off the RESOLVED answers rather than the posted ids: the snapshot
      // already carries each choice's shelf link, looked up from this tenant's
      // own tables, so this pass needs no second lookup of its own.
      rows.forEach((r, i) => {
        for (const o of answers.lines[i].options) {
          if (o.stock_product_id && deadAddons.has(o.stock_product_id)) { soldOut.push(r.pid); break; }
        }
      });
    }
  }
  // De-duplicated: since §120 one product may hold several lines, and the
  // customer should be told once that the latte has gone, not once per sugar
  // level they chose.
  const soldOutIds = [...new Set(soldOut)];
  if (soldOutIds.length) {
    // Refused whole rather than silently short — a customer must never be
    // charged for, or handed, something different from what they chose.
    return res.status(409).json({
      success: false, error: 'unavailable',
      items: soldOutIds.map(pid => ({ store_product_id: pid, name_en: byId.get(pid).name_en, name_cn: byId.get(pid).name_cn })),
    });
  }

  const cur = normalizeCurrency(cfg('currency', null));
  const lines = rows.map((r, i) => {
    const l = byId.get(r.pid);
    // BASE PLUS WHAT WAS CHOSEN. The base is the shop's listing price (§42 puts
    // it on the listing, not on the product) and the delta is the sum of this
    // tenant's own price_delta columns, resolved by lib/product-options.js from
    // choice IDS alone. Nothing in this sum came from the browser, and the base
    // is the half the module deliberately does not know.
    let unit = Math.round(((Number(l.price) || 0) + answers.lines[i].delta) * 100) / 100;
    // A negative delta could in principle take a line below zero, which is not
    // a price. Clamped rather than refused: the operator's own numbers put it
    // there and a customer standing at a counter should not meet a 500.
    if (!(unit >= 0)) unit = 0;
    const opts = answers.lines[i].options;
    return { l, pid: r.pid, qty: r.qty, unit, opts,
             lineTotal: Math.round(unit * r.qty * 100) / 100 };
  });
  const subtotal = Math.round(lines.reduce((n, r) => n + r.lineTotal, 0) * 100) / 100;

  // Taxed by the same code as a till sale at the same counter. A shop that
  // charges tax charges it however the customer reached it.
  const taxCfg = taxSettings();
  const taxLine = tax.taxOn({ subtotalMinor: moneyLib.toMinor(subtotal) || 0 }, taxCfg);
  let total = subtotal;
  if (taxLine.addedMinor) total = moneyLib.round(total + moneyLib.fromMinor(taxLine.addedMinor));

  let created;
  try {
    const h = tdb();
    // ONE TRANSACTION, and the code allocation is inside it. MAX + 1 over the
    // shop's day is only safe if the read and the insert cannot interleave;
    // better-sqlite3 serialises transactions, so two customers submitting at
    // once cannot be handed the same number.
    created = h.transaction(() => {
      const orderNo = nextOrderNo(h);
      const { code: shopCode, date: shopDate } = allocateShopOrderCode(h, shop.location_id);
      // The unguessable handle the payment page is reached by — the same
      // mechanism, the same width and the same column the guest pay page has
      // used since manual orders got one. It is minted for every QR order, not
      // only the WeChat ones: it costs nothing on an order nobody pays online,
      // and an order that acquires a payment page later would otherwise need a
      // second way to be addressed.
      const payToken = crypto.randomBytes(18).toString('hex');
      // THE TENDER IS 'offline', NOT 'counter', AND THAT IS DELIBERATE.
      // Nobody has paid yet: the customer walks to the till after submitting,
      // and the real tender — cash, bank transfer, off-app WeChat or Alipay —
      // is written by staff's Mark-paid, which overwrites this column with what
      // actually arrived. 'offline' is the value routes/retail.js already gives
      // an unpaid order at create (its ALLOWED_PAY fallback) and the one every
      // reader of this column understands. 'counter' is in NO such list: it
      // would render as a raw string in the admin's tender picker and reconcile
      // against nothing — the same mistake as the invented status above, one
      // column over.
      const PLACEHOLDER_TENDER = 'offline';
      const info = h.prepare(`
        INSERT INTO retail_orders (
          order_no, customer_id, status, payment_method,
          recipient_name, subtotal, shipping_fee, packing_fee, total,
          channel, fulfillment_type, store_id,
          shop_entry_method, shop_order_code, shop_order_date,
          tax_amount, tax_rate_micro, tax_mode, pay_token, placed_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      `).run(
        orderNo, null, 'pending_payment', PLACEHOLDER_TENDER,
        name, subtotal, 0, 0, total,
        // §44: till and QR share the channel `shop` and are told apart by
        // shop_entry_method, so a shop's revenue is never split across two
        // channel lines.
        //
        // `source` IS DELIBERATELY NOT WRITTEN, and its absence is the value.
        // The column records how a row was CREATED — keyed in by staff, or
        // arrived by itself — which §44's 2026-09-07 amendment states and which
        // routes/retail.js enforces by binding 'manual' itself and refusing to
        // let a client claim it. A QR order arrived by itself, so it leaves the
        // column NULL, exactly as the mini-app checkout, the web store and the
        // Meituan / Eleme / gzgrocery mirrors all already do: every one of them
        // omits `source` from its INSERT. Nothing new is invented here; this
        // path simply stops being the only self-service writer that claimed a
        // value, which is the defect §44's amendment recorded.
        'shop', 'counter', shop.location_id,
        'qr', shopCode, shopDate,
        taxCfg.enabled ? moneyLib.fromMinor(taxLine.taxMinor) : null,
        taxCfg.enabled ? taxCfg.rateMicro : null,
        taxCfg.enabled ? taxCfg.mode : null,
        payToken
      );
      const orderId = info.lastInsertRowid;

      // options_json IS THE COLUMN THAT ALREADY EXISTED, and using it is what
      // made §120 a day's work rather than a week's. database.js describes it
      // as "chosen option labels + price deltas, for the receipt"; the web and
      // mini-app checkouts have filled it for as long as either has had
      // options, lib/feie.js prints it on both ticket templates, and the admin
      // order detail parses it back out. This path was the only one writing
      // order lines that left it null. NULL when nothing was chosen, never
      // '[]' — that is the shape every reader already handles.
      const insItem = h.prepare(`
        INSERT INTO retail_order_items
          (order_id, product_id, name_en, name_cn, sku, size, qty, unit_price, line_total,
           ship_modes, needs_ice_pack, ship_from_supplier, unit_cost_at_sale, options_json,
           options_cost_at_sale)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const r of lines) {
        insItem.run(
          orderId, r.pid, r.l.name_en, r.l.name_cn, r.l.sku, r.l.size, r.qty, r.unit, r.lineTotal,
          r.l.ship_modes || 'air,land',
          r.l.needs_ice_pack ? 1 : 0,
          r.l.ship_from_supplier ? 1 : 0,
          costAtSale(h, r.pid),
          r.opts.length ? JSON.stringify(r.opts) : null,
          // The same two figures a till sale records, for the same reason the
          // export block in routes/retail.js gives: a QR sale and a till sale at
          // one counter must be costed by the SAME code, or the margin report
          // cannot be reconciled. §120 already reserves a stock-backed extra
          // here — this is what that extra COST.
          optionsCostAtSale(h, r.opts)
        );
      }
      h.prepare(
        "INSERT INTO retail_payments (order_id, method, amount, status, out_trade_no) VALUES (?,?,?,'pending',?)"
      ).run(orderId, PLACEHOLDER_TENDER, total, orderNo);

      // §45: a QR order RESERVES on submit and decrements on paid. Stocked
      // lines only — a made-here item has no shelf to hold (§43).
      //
      // AND A STOCK-BACKED EXTRA HOLDS ITS OWN (§120). An oat milk that was
      // chosen is a real thing coming off a real shelf, so it is reserved
      // alongside the drink it was chosen for — one per unit bought, which is
      // how expandStockLines has always counted them on the web side. Without
      // this the submit gate would refuse a sold-out extra and then let the
      // next order take the last one twice.
      //
      // Aggregated across lines, because two sugar levels of the same latte are
      // two lines and one shelf.
      const resWant = new Map();
      const wantRes = (id, qty) => resWant.set(id, (resWant.get(id) || 0) + qty);
      for (const r of lines) {
        if (r.l.fulfilment_mode === 'stocked') wantRes(r.pid, r.qty);
        for (const o of r.opts) if (o.stock_product_id) wantRes(o.stock_product_id, r.qty);
      }
      const resItems = [...resWant].map(([product_id, qty]) => ({ product_id, qty }));
      if (resItems.length) {
        inventory.reserveForOrder(
          { storeId: shop.location_id, orderId, items: resItems, channel: SHOP_CHANNEL }, h
        );
      }
      return { orderId, orderNo, shopCode, shopDate, payToken };
    })();
  } catch (e) {
    console.error('[shop-menu/order]', code, e.message);
    return res.status(500).json({ success: false, error: 'order_failed' });
  }

  // NOTHING PRINTS HERE ANY MORE — Ash, 2026-09-08. §44 ruled the ticket prints
  // on submit and §50 kept that for every path but in-page WeChat; this narrows
  // it the rest of the way, so EVERY QR order prints when the money lands and
  // none prints on submit.
  //
  // WHAT CHANGED UNDERNEATH THE OLD RULE. §44's reasoning was that the customer
  // is walking to a till with staff watching them, so the ticket may as well be
  // ahead of them. That held while the counter had no way to see the order
  // before the customer arrived. It now does: the till lists today's unpaid QR
  // orders and the cashier opens the one whose number the customer is holding
  // up. The kitchen's signal is that list, not a slip that printed minutes
  // earlier for someone who may still be deciding.
  //
  // THE COST IS NAMED RATHER THAN DISCOVERED, because it is the same trade §50
  // recorded and it now falls on every order: the drink is started when the
  // customer reaches the counter instead of while they walk. Bought against a
  // ticket printed for food nobody pays for — which on this page is not
  // hypothetical, since submitting costs the customer nothing and closing the
  // tab costs them nothing either.
  //
  // NOTHING IS NEEDED IN autoPrintOrder FOR THIS TO WORK, and the reason is
  // worth keeping because it looks like an omission. Its skip guard is
  // `shop_entry_method='qr' AND print_status='printed'` (it read `source='qr'`
  // until §44's 2026-09-07 amendment) — deliberately narrow, per its own
  // comment. A QR order now reaches the paid transition having never printed,
  // so print_status is null, the guard does not fire, and the paid path prints
  // it exactly once, whether the money arrived through the till or through the
  // in-page rail when that is switched back on.

  // RING THE COUNTER. The till polls every fifteen seconds as its floor, which
  // means a customer can reach the counter before their own order does. This
  // is the doorbell: the till re-reads its pending list the moment the socket
  // says something landed.
  //
  // AFTER the commit and fire-and-forget, on exactly the reasoning the print
  // used to carry here — a dead socket must not roll back an order that is
  // otherwise good. And it carries no order data, only the shop: the till
  // re-reads through /api/retail-admin/orders, which enforces the tenant scope
  // and the capability that this channel deliberately does not try to.
  try {
    let tenantId = null;
    try { tenantId = require('../lib/tenant-db').currentTenantId(); } catch (e) { tenantId = null; }
    require('./shop-events').shopOrderPlaced(tenantId, shop.location_id);
  } catch (e) { console.warn('[shop-menu/notify]', created.orderNo, e.message); }

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.status(201).json({
    success: true,
    data: {
      // Present only on the WeChat path. The browser reads its presence as
      // "go here next" rather than being told separately which path it is on,
      // so the two cannot disagree.
      ...(wantsWechat ? { pay_url: `/s/${code}/pay/${created.payToken}` } : {}),
      // WHERE THIS ORDER LIVES FROM NOW ON. Always present, on every path.
      // Reported 2026-09-08: a customer closed the sheet carrying their number
      // and had nothing left, because the number only ever existed on that
      // screen. The order has always had a durable page — this hands the
      // customer the address of it so the menu can remember it and they can
      // get back to it.
      order_url: `/s/${code}/pay/${created.payToken}`,
      // The short code is what staff call and what the customer watches for.
      order_code: created.shopCode,
      order_no: created.orderNo,
      name,
      status: 'pending_payment',
      total,
      currency: cur,
      // The done screen draws these rows, and since §120 a row that was
      // configured must say so — the customer has just paid attention to those
      // answers and the receipt in front of them should carry them.
      items: lines.map(r => ({
        store_product_id: r.pid, name_en: r.l.name_en, name_cn: r.l.name_cn,
        qty: r.qty, unit_price: r.unit, line_total: r.lineTotal,
        options: r.opts.map(o => ({
          q_en: o.question_en || '', q_cn: o.question_cn || o.question_en || '',
          en: o.label || '', cn: o.label_cn || o.label || '',
        })),
      })),
    },
  });
});

// ─── THE PAYMENT PAGE (§50) ─────────────────────────────────────────────
//
// One route, reached only from a placed order, and it renders one of three
// things: pay now, paid, or pay at the counter.
//
// THE COUNTER SCREEN IS THE FALLBACK FOR EVERY FAILURE, and that is the whole
// safety design of this page. A missing Official Account, a refused code, a
// WeChat API that is down, a customer who opened the menu from a camera app
// rather than WeChat's scanner (§50's second ruling), a cancelled payment — all
// of them land on the same screen telling them to walk to the till, which is
// the flow that worked before this page existed and still works. There is no
// state this page can reach where the customer is told nothing.
//
// IT SETTLES NOTHING ITSELF. The money is confirmed by WeChat's async notify to
// routes/retail.js, which settles retail_payments → markOrderPaid → stock,
// books and the kitchen ticket. What the browser reports back here is used only
// to choose which screen to show; a customer who claims success they did not
// have gets a screen, not a paid order.
// THIS IS THE CUSTOMER'S ORDER PAGE, not only a payment screen. Reported
// 2026-09-08: a customer closed the sheet that carried their number and had
// nothing left — no number to be called by, no amount, no order at all. It was
// only ever on screen, so closing it was losing it.
//
// The page for that already existed and only ever showed a status: this route,
// reached by the unguessable pay_token the order has carried since §50. It now
// carries the number, the amount and the way to cancel as well, and the menu
// remembers the token so the customer can get back here. One page for "what did
// I order", "has it been paid" and "I changed my mind".
//
// `extra` is the cancel control, and is passed only where cancelling is
// actually possible — see the route.
/* THE WAY BACK TO THE MENU — reported 2026-09-08 from a phone: "customer can't
   go back from this page. dead end."

   And it was one. Every screen in this family — order placed, payment
   received, cancelled — ended at the order and offered nothing but the browser
   chrome, which inside a WeChat web view is a single X that closes the whole
   thing. The customer who wanted a second coffee had to find the QR code again
   to get back to a menu they were on ninety seconds ago.

   It matters most on the screen that reads CANCELLED, which says "You can
   place a new one anytime." and, until this, gave no way to.

   A PLAIN LINK, like the cancel form beside it: this page is where a customer
   lands when something has gone wrong, and nothing on it should need a working
   script. Back · 返回 is a live pair in six places (public/till.html:885,
   public/m.html:3217, public/retail-admin/28-shops.js:203 among them) — the
   admin's own word for this, reused rather than composed. */
function backLink(req) {
  const code = String(req.params.shopCode || '');
  // THE LANGUAGE IS CARRIED ONLY WHERE THE CUSTOMER'S OWN ADDRESS CARRIED ONE,
  // and that is not tidiness. langScript's order is: this session's toggle
  // first, then an explicit ?lang=, then the phone's own language — and the
  // third step is switched OFF by the presence of the second. Appending a lang
  // nobody asked for would therefore force English on a Chinese phone that had
  // simply never touched the toggle. Where they did ask, it is carried, so the
  // choice survives the link even on a phone whose sessionStorage throws.
  const q = (req.query.lang === 'cn' || req.query.lang === 'en')
    ? `?lang=${req.query.lang}` : '';
  return `<a class="bk" href="/s/${encodeURIComponent(code)}${q}">` +
    `<span class="cv">‹</span>${bi('Back', '返回')}</a>`;
}

/* THE LINES OF A PLACED ORDER — reported 2026-09-08 from a phone: "after order
   was made customer cant see the order details at all, nowhere."

   AND THERE WAS NOWHERE. The items were written to retail_order_items the
   moment the order was created and then never read back on any customer
   surface: this page selected the header columns only, and the done sheet
   threw away the items the create response had already handed it. The
   customer's own basket is memory only, and submitting clears it — so between
   them, the shop kept every line of the order and showed the customer none of
   them.

   READ HERE RATHER THAN JOINED INTO THE HEADER QUERY, because one order has
   many lines and the header must stay one row. The read is by order_id, which
   is the table's own index.

   IT NEVER TAKES THE PAGE DOWN. An order page that failed to draw because the
   items table would not answer would cost the customer the number they are
   about to be called by — the one thing this screen exists to carry. A failed
   read renders no lines, exactly as an order with none would.

   BILINGUAL WITH NOTHING COMPOSED. name_en and name_cn are on every row,
   written from the menu the customer ordered from, so bi() has both halves of
   every string it needs and no wording is invented here. */
function orderLines(orderId, cur) {
  let rows;
  try {
    rows = tdb().prepare(
      `SELECT name_en, name_cn, qty, line_total, options_json
         FROM retail_order_items WHERE order_id = ? ORDER BY id`
    ).all(orderId);
  } catch (e) {
    console.error('[shop-menu/lines]', orderId, e.message);
    return '';
  }
  if (!rows || !rows.length) return '';
  // WHAT WAS CHOSEN, ON THE ORDER'S OWN PAGE (§120). The customer comes back to
  // this page to check what they asked for, and a latte that says nothing about
  // its sugar level is the page failing at the one job it has. `Question:
  // Answer`, the same shape the basket drew and the same shape the kitchen
  // ticket prints (lib/feie.js's optLine).
  //
  // READ DEFENSIVELY, because this column is older than this page's use of it
  // and holds rows written by three other checkouts. A bare string entry — the
  // shape the very oldest rows use — still renders, as its answer with no
  // question in front of it.
  const optLines = (json) => {
    let v;
    try { v = JSON.parse(json || 'null'); } catch { return ''; }
    if (!Array.isArray(v) || !v.length) return '';
    return v.map(o => {
      if (o && typeof o === 'object') {
        const en = String(o.label != null ? o.label : (o.label_en || '')).trim();
        const cn = String(o.label_cn || en).trim();
        if (!en && !cn) return '';
        const qEn = String(o.question_en || '').trim();
        const qCn = String(o.question_cn || qEn).trim();
        return `<div class="ln-o">${bi(qEn ? `${qEn}: ${en}` : en, qCn ? `${qCn}: ${cn}` : cn)}</div>`;
      }
      const t = String(o == null ? '' : o).trim();
      return t ? `<div class="ln-o">${bi(t, t)}</div>` : '';
    }).join('');
  };
  return `<div class="done-it">` + rows.map(r =>
    `<div class="ln"><div class="ln-t">${bi(r.name_en, r.name_cn)}${optLines(r.options_json)}</div>` +
      `<div class="ln-r">` +
        `<span class="ln-q">×${esc(String(r.qty))}</span>` +
        `<div class="ln-p">${esc(money(r.line_total, cur))}</div>` +
      `</div>` +
    `</div>`).join('') + `</div>`;
}

function payScreen(req, res, { status, order, main, extra, shop }) {
  const { vars, fonts } = themeBits();
  const lang = req.query.lang === 'cn' ? 'cn' : 'en';
  const cur = normalizeCurrency(cfg('currency', null));
  // THE TONE IS READ OFF THE ORDER, not passed in beside it. A caller that
  // chose the screen and the colour separately could hand the paid screen the
  // colour that means "money is still owed", which is the exact confusion this
  // class exists to end. One source, and it is the row itself.
  const tone = order.status === 'paid' ? ' paid'
    : order.status === 'cancelled' ? ' void' : '';
  // The bar carries the shop's name here for the same reason it carries it on
  // the menu: it was an empty band with a 2px rule under it and one small
  // toggle at the far left, and a customer holding an order wants to know
  // whose counter it is at. shopName() is the menu's own, so no name is
  // written into this file.
  const name = shopName(shop);
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.status(status).type('html').send(shell({
    lang, hasParam: req.query.lang === 'cn' || req.query.lang === 'en',
    title: brandText(), vars, faces: fontFaces(fonts),
    body: `<div class="ordp${tone}">` +
      `<div class="bar"><div class="nm">${bi(name.en, name.cn)}</div>${toggle(lang)}</div>` +
      `<div class="done">` +
        // WHO THE ORDER IS FOR, in one block with one left edge: the number
        // that will be called, the name it will be called with, and the
        // reference that identifies it if anything has to be looked up. The
        // order code used to sit below the total, between the amount and a
        // button, which is the one place on the screen it explains nothing.
        `<div class="done-hd">` +
          `<div class="done-n">${esc(String(order.shop_order_code == null ? '' : order.shop_order_code))}</div>` +
          `<div class="done-who">` +
            `<div class="done-nm">${esc(String(order.recipient_name || ''))}</div>` +
            `<div class="done-o">${bi('Order', '订单号')} ${esc(String(order.order_no || ''))}</div>` +
          `</div>` +
        `</div>` +
        main +
        // THE LINES, THEN THE TOTAL — the order the basket already reads in,
        // and the order a receipt reads in. Between the status and the amount
        // rather than below it, because the amount is what the two of them add
        // up to: a total printed above the things it totals asks the customer
        // to read the screen backwards.
        orderLines(order.id, cur) +
        // The amount, in the same formatter the done sheet uses, so the figure
        // the customer was shown when they ordered is the figure they find
        // when they come back to it — and now LABELLED with the pair the
        // basket footer already draws, because on a one-line order the same
        // number appeared twice with nothing saying which was the line and
        // which was the total.
        `<div class="done-amt">` +
          `<span class="done-amt-l">${bi('Total', '合计')}</span>` +
          `<span class="done-amt-v">${esc(money(order.total, cur))}</span>` +
        `</div>` +
        // The cancel stays here, under the total and behind its own
        // disclosure: away from the bottom of the screen, which is where the
        // thumb rests and where the safe way out now lives.
        (extra || '') +
      `</div>` +
      // THE WAY OUT, IN A RAIL AT THE FOOT OF THE PAGE rather than adrift in
      // the middle of it. It is still the only control down there, and it is
      // still the safe one.
      `<div class="ord-f">${backLink(req)}</div>` +
      `</div>`,
  }));
}

// Both of these are LIVE PAIRS, copied rather than composed: `支付成功！` is the
// web storefront's own payment-received line and `请到收银台付款。` is already
// on this file's done screen. The customer paying at a counter and the one
// paying in the web store are the same person (§30).
const PAID_MAIN =
  `<div class="done-h">${bi('Payment received!', '支付成功！')}</div>`;
const COUNTER_MAIN =
  `<div class="done-h">${bi('Order placed!', '下单成功！')}</div>` +
  `<div class="done-s">${bi('Pay at the counter.', '请到收银台付款。')}</div>`;
// The third state this page can be in. Reported 2026-09-08: a customer who
// changed their mind had no way to say so, and staff had no way to clear the
// order off the counter's list except by taking money for it. `已取消` is the
// admin's own label for this status (public/retail-admin/04-orders.js:2777) and
// the mini app's (miniapp/pages/order/order.js:38) — the same word for the same
// state, not an approximation of one.
const CANCELLED_MAIN =
  `<div class="done-h">${bi('Cancelled', '已取消')}</div>`;

/* THE CUSTOMER CANCELS THEIR OWN ORDER — Ash, 2026-09-08.
   "if a customer eventually doesn't want the order there should be an option to
   cancel it from his side or from the till."

   THE TOKEN IS THE AUTHORITY, and it is the only one available: this page has
   no login, no session and no account (§44), so the unguessable pay_token the
   order has carried since §50 is what proves the person holding it placed the
   order. Same handle the payment page is reached by, same width, same column.

   ONLY WHILE IT IS STILL UNPAID. Past pending_payment the money has moved or
   the kitchen has it, and unwinding either is a person's job at the counter,
   not a button on a phone. The transition is guarded IN THE UPDATE rather than
   around it — `AND status = 'pending_payment'` — so a cancel racing the
   cashier's Mark paid loses cleanly instead of both appearing to win.

   IT RELEASES THE HOLD. §45: a QR order reserves on submit, and a cancel that
   left the reservation behind would take a drink off the shelf for nobody
   until the sweep noticed. Same inventory call the admin and mini-app cancels
   already make, with its own reason so the ledger says who did it.

   NO POINTS, VOUCHERS OR BALANCE TO REVERSE, and that is a property of this
   door rather than an omission: a QR order is placed with no customer_id, so
   there is no account any of them could have come from. The customer-cancel
   path in routes/retail.js reverses all three because its orders have one.

   A FORM POST, so it answers with a redirect rather than JSON — the page it
   came from has no script to read a body. */
router.post('/s/:shopCode/order/:token/cancel', CANCEL_LIMIT, express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  const code = String(req.params.shopCode || '');
  if (!isShopCode(code)) return notFoundPage(req, res);
  const shop = resolveShop(code);
  if (!shop) return notFoundPage(req, res);

  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{16,64}$/i.test(token)) return notFoundPage(req, res);

  const order = tdb().prepare(
    `SELECT id, status, store_id, shop_entry_method FROM retail_orders WHERE pay_token = ?`
  ).get(token);
  // Same 404 the pay page gives for an order that is not this shop's or did not
  // come in by this door — this route must not confirm which guesses hit
  // something real either.
  if (!order || order.store_id !== shop.location_id || order.shop_entry_method !== 'qr') {
    return notFoundPage(req, res);
  }

  const flipped = tdb().prepare(
    `UPDATE retail_orders
        SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP,
            cancelled_reason = 'customer_cancelled_qr', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending_payment'`
  ).run(order.id);

  if (flipped.changes) {
    // The pending payment row goes with it, so the admin queue does not keep a
    // stale 'pending' beside a cancelled order.
    try {
      tdb().prepare(
        "UPDATE retail_payments SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'"
      ).run(order.id);
    } catch (e) { console.error('[shop-menu/cancel payments]', e.message); }
    try { inventory.releaseOrderReservations(order.id, { reason: 'customer_cancelled_qr' }); }
    catch (e) { console.error('[shop-menu/cancel release]', e.message); }
    // Ring the counter: the order has to come OFF the pending list as promptly
    // as it went on, or a cashier calls a number nobody is waiting for.
    try {
      let tenantId = null;
      try { tenantId = require('../lib/tenant-db').currentTenantId(); } catch (e) { tenantId = null; }
      require('./shop-events').shopOrderPlaced(tenantId, shop.location_id);
    } catch (e) { /* the till's poll is still the floor */ }
  }

  // Whether we won the race or not, the customer is sent back to their order
  // page, which now states what actually happened to it. Losing the race means
  // it was paid a second before they tapped, and the page says paid — which is
  // the truth and is more use than an error about it.
  res.redirect(303, `/s/${encodeURIComponent(code)}/pay/${encodeURIComponent(token)}`);
});

router.get('/s/:shopCode/pay/:token', async (req, res) => {
  const code = String(req.params.shopCode || '');
  if (!isShopCode(code)) return notFoundPage(req, res);
  const shop = resolveShop(code);
  if (!shop) return notFoundPage(req, res);

  // Same shape the guest pay page validates, so a malformed token never
  // reaches the database.
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{16,64}$/i.test(token)) return notFoundPage(req, res);

  const order = tdb().prepare(
    `SELECT id, order_no, status, total, recipient_name, shop_order_code, store_id,
            shop_entry_method
       FROM retail_orders WHERE pay_token = ?`
  ).get(token);
  // AN ORDER FROM ANOTHER SHOP IS A 404, not an error — the same answer a wrong
  // shop code gets, for the same reason the menu gives it (this page must not
  // confirm which guesses hit something real).
  //
  // THE DOOR TEST READS shop_entry_method, NOT source, as of §44's 2026-09-07
  // amendment. It read `source !== 'qr'` until then. This page exists for an
  // order placed on the QR menu, so what it needs to know is which door the
  // order came through — which is precisely the question shop_entry_method
  // answers and `source` does not: `source` records how the row was CREATED,
  // and a till sale keyed by staff and a QR order that arrived by itself are
  // not told apart by it.
  if (!order || order.store_id !== shop.location_id || order.shop_entry_method !== 'qr') {
    return notFoundPage(req, res);
  }

  if (order.status === 'paid') return payScreen(req, res, { status: 200, order, main: PAID_MAIN, shop });
  // A cancelled order still answers here rather than 404ing. The customer who
  // just cancelled it lands on this page, and "the order does not exist" is the
  // wrong thing to tell somebody about an order they placed ten minutes ago.
  if (order.status === 'cancelled') return payScreen(req, res, { status: 200, order, main: CANCELLED_MAIN, shop });

  /* CANCELLING, and why it is a <details> and a plain form rather than a
     confirm() and a fetch.

     A DESTRUCTIVE ACTION NEEDS A SECOND STEP, and the disclosure IS that step:
     tapping "Cancel order" reveals the question and the button that answers it.
     No JavaScript at all, so it works in every browser WeChat has ever shipped
     and in the camera-app browsers §50 already has to cope with — and this page
     is the one place a customer reaches when something has gone wrong, which is
     the worst possible place for a control that needs a working script.

     NOT confirm(). A browser dialog is the thing the till is asserted never to
     open, and a customer surface should hold the same line.

     Every string is a live pair from the mini app's own order screen
     (miniapp/pages/order/order.js:99-101, 275-277) — the customer cancelling on
     their phone in the app and the one cancelling on their phone at a table are
     the same person doing the same thing (§30). */
  const cancelBlock =
    `<details class="cx">` +
      `<summary>${bi('Cancel order', '取消订单')}</summary>` +
      `<div class="cx-b">` +
        `<div class="cx-q">${bi('Cancel this order?', '取消此订单?')}</div>` +
        `<div class="cx-s">${bi('You can place a new one anytime.', '您可以随时重新下单。')}</div>` +
        `<form method="post" action="/s/${esc(code)}/order/${esc(token)}/cancel">` +
          `<button class="cx-go" type="submit">${bi('Cancel order', '取消订单')}</button>` +
        `</form>` +
      `</div>` +
    `</details>`;

  const counter = () => payScreen(req, res, {
    status: 200, order, main: COUNTER_MAIN, shop,
    // Offered only while the order is still unpaid and still this shop's to
    // cancel. Past that the money has moved or the kitchen has it, and the
    // answer is a person at the counter rather than a button here.
    extra: order.status === 'pending_payment' ? cancelBlock : '',
  });

  // Anything other than an order still waiting for money — cancelled, refunded,
  // already in the kitchen — is not payable here. The till can always take it.
  if (order.status !== 'pending_payment' || !oaReady()) return counter();

  // §50's second ruling, and it is checked BEFORE the redirect rather than
  // after: a customer who scanned with a phone camera is in Safari or Chrome,
  // where the authorize URL leads to WeChat's own error page and no further.
  // They are told to pay at the till, which is where they were always going.
  if (!inWeChat(req)) return counter();

  // ── leg 1: no code yet, so go and get one ──────────────────────────────
  // snsapi_base is silent: the customer sees a redirect and comes straight
  // back, with no consent sheet and nothing to tap.
  if (!req.query.code) {
    try {
      return res.redirect(wechatOa.authorizeUrl({
        appId: oaPayContext().appId,
        redirectUri: payReturnUrl(req, code, token),
        state: payState(token),
      }));
    } catch (e) {
      console.warn('[shop-menu/pay authorize]', order.order_no, e.message);
      return counter();
    }
  }

  // ── leg 2: back from WeChat with a code ────────────────────────────────
  // The state must recompute from this order's own token. A code arriving
  // against a state that does not is not one we asked for, and is dropped to
  // the counter rather than exchanged.
  if (String(req.query.state || '') !== payState(token)) {
    console.warn('[shop-menu/pay state]', order.order_no, 'state mismatch');
    return counter();
  }

  let params, appId;
  try {
    const p = oaPayContext();
    appId = p.appId;
    const { openid } = await wechatOa.exchangeCodeForOpenid(req.query.code, {
      appId: p.appId, appSecret: p.oaAppSecret,
    });
    // THE AMOUNT IS READ FROM THE ORDER, never from the page. Same rule the
    // submit handler states about prices, one step further along: a customer
    // cannot choose what they are charged.
    const prepayId = await wechatJsapiPrepare({
      outTradeNo:  wxOutTradeNo(order.order_no),
      description: payDescription(order.order_no),
      amountCents: Math.round(Number(order.total) * 100),
    }, openid, p);
    // The callback finds the order by out_trade_no, exactly as every other
    // WeChat rail stamps it before returning.
    //
    // THE TENDER MOVES OFF 'offline' HERE TOO. The submit handler writes
    // 'offline' as a placeholder because nobody has paid at that point and
    // staff's Mark-paid would name the real one; a charge signed against the
    // merchant IS the real one, and leaving the placeholder would file a WeChat
    // payment under the tender the books use for cash. If this charge is never
    // completed and the customer pays at the till instead, staff's Mark-paid
    // overwrites it exactly as it does today.
    tdb().prepare(
      "UPDATE retail_payments SET method = 'wechat', out_trade_no = ? WHERE order_id = ? AND status = 'pending'"
    ).run(wxOutTradeNo(order.order_no), order.id);
    tdb().prepare(
      "UPDATE retail_orders SET payment_method = 'wechat' WHERE id = ? AND status = 'pending_payment'"
    ).run(order.id);
    params = { appId, ...buildWxPayParams(prepayId, p) };
  } catch (e) {
    console.error('[shop-menu/pay prepare]', order.order_no, e.message);
    return counter();
  }

  // ── leg 3: hand the signed charge to WeChat's own payment sheet ────────
  // getBrandWCPayRequest rather than the JS-SDK's chooseWXPay: it needs no
  // jsapi_ticket, no wx.config and no signature over the page URL, so there is
  // no ticket cache to keep and nothing that breaks when the URL changes.
  //
  // Both screens are rendered now and CSS decides, exactly as the language
  // halves do. Showing "paid" the instant WeChat says ok — rather than
  // reloading — is deliberate: the async notify may be a second or two behind,
  // and a reload could show the customer an unpaid order they have just paid.
  // BOTH FACES OF THIS PAGE GET THE LINES TOO, for the same reason payScreen
  // does: a customer who dismisses WeChat's own sheet is left standing on the
  // waiting face, which is a counter screen like any other, and one who pays is
  // left on the paid face wondering what they just bought. Read once — the two
  // blocks are one document and only CSS chooses between them.
  const lines = orderLines(order.id, normalizeCurrency(cfg('currency', null)));

  // THE SAME BLOCK THE OTHER TWO SURFACES DRAW — see the .done rules. One order
  // rendered three ways is one screen, and this face was the last of the three
  // still on the old centred column.
  const head = `<div class="done-hd">` +
    `<div class="done-n">${esc(String(order.shop_order_code == null ? '' : order.shop_order_code))}</div>` +
    `<div class="done-who">` +
      `<div class="done-nm">${esc(String(order.recipient_name || ''))}</div>` +
      `<div class="done-o">${bi('Order', '订单号')} ${esc(String(order.order_no || ''))}</div>` +
    `</div>` +
  `</div>`;
  // AND IT SAYS WHAT IS BEING CHARGED. This screen has shown the lines since
  // v4.160 and never the figure they come to — on the one page whose whole
  // purpose is a customer about to hand money over. Same labelled row as the
  // order page, same formatter, so the two cannot disagree.
  const amount = `<div class="done-amt">` +
    `<span class="done-amt-l">${bi('Total', '合计')}</span>` +
    `<span class="done-amt-v">${esc(money(order.total, normalizeCurrency(cfg('currency', null))))}</span>` +
  `</div>`;

  const paid = `<div class="done" id="payOk" hidden>` +
    head +
    PAID_MAIN +
    lines +
    amount +
    // BOTH FACES OF THIS PAGE GET THE WAY BACK, not only the one that renders
    // first. They are two blocks in one document with CSS choosing between
    // them, so a link on the waiting screen alone would vanish at the moment
    // the payment lands — which is exactly when a customer is finished here
    // and looking for the menu.
    backLink(req) +
    `</div>`;

  const script =
    // `<` is escaped out of the JSON even though every value in it is
    // server-made (an appid, a timestamp, a nonce, a base64 signature) and none
    // could carry one. A </script> inside a script literal ends the element
    // wherever it appears, and the cost of being wrong about "could never
    // contain" is the whole page.
    `(function(){var p=${JSON.stringify(params).replace(/</g, '\\u003c')};` +
    `var wait=document.getElementById('payWait'),ok=document.getElementById('payOk');` +
    `var go=function(){WeixinJSBridge.invoke('getBrandWCPayRequest',p,function(r){` +
    // Anything that is not ok — cancelled, failed, closed — leaves the counter
    // screen exactly where it already is. The customer is in the shop and the
    // till works.
    `if(r&&r.err_msg==='get_brand_wcpay_request:ok'){if(wait)wait.hidden=true;if(ok)ok.hidden=false}})};` +
    // The bridge is not always there on first paint; WeChat fires this event
    // when it is. Both orders are handled because either can happen.
    `if(typeof WeixinJSBridge==='undefined'){` +
    `document.addEventListener('WeixinJSBridgeReady',go,false)}else{go()}})();`;

  const { vars, fonts } = themeBits();
  const lang = req.query.lang === 'cn' ? 'cn' : 'en';
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.status(200).type('html').send(shell({
    lang, hasParam: req.query.lang === 'cn' || req.query.lang === 'en',
    title: brandText(), vars, faces: fontFaces(fonts),
    body: `<div class="bar">${toggle(lang)}</div>` +
      `<div class="done" id="payWait">` +
        head +
        COUNTER_MAIN +
        lines +
        amount +
        backLink(req) +
      `</div>` + paid +
      `<script>${script}</script>`,
  }));
});

module.exports = router;
// The rate limiter is exported so a suite can prove it fires and then clear the
// count — without this, the first dozen checks would silently starve every
// later one of a 2xx and the failures would read as bugs in the handler.
module.exports.orderLimiter = ORDER_LIMIT;
