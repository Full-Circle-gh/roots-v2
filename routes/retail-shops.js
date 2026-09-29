// Shops and shop listings — the admin API behind Sales → Locations → Shop menu.
//
// docs/tacet-consolidation-decisions.md §41 (a shop is a record attached to a
// location), §42 (one catalogue; fulfilment mode lives on the shop listing) and
// §44 Routing (the public code is opaque). The tables are in database.js under
// SHOPS and SHOP LISTINGS, with the reasoning beside them.
//
// ADMIN ONLY. Every route here sits under /api/retail-admin/ behind the same
// dual-realm gate as the rest of the admin. Nothing in this file is public and
// nothing serves a menu: the /s/:shopCode page is designed separately and is
// not built here.
//
// THE TABLE IS STILL ONLY READ HERE AND IN THE PUBLIC MENU — scripts/
// test_shop_listings.js holds that line — but the second sentence this block
// used to carry, that the till is unchanged by this file, is no longer true.
// §150 gives the counter till its catalogue from here, for the reason the
// counter-catalogue route at the foot of this file sets out. The till FETCHES
// that route and never names the table, so the containment is unwidened.
//
// WHAT IS NEVER WRITABLE THROUGH THIS API
//   • shops.public_code — minted once at creation by lib/shop-code.js and never
//     edited, because a printed QR is a promise about it.
//   • shops.location_id — a shop belongs to the location it was created on.
//   • shop_listings.store_product_id — a listing is removed and another added;
//     it is never re-pointed, so its price and mode can't silently move to a
//     different product.

'use strict';

const express = require('express');
const { tdb } = require('../lib/tenant-db');
const { newShopCode } = require('../lib/shop-code');
const { menuUrlFor } = require('../lib/shop-qr');
const { currentTenantId } = require('../lib/tenant-db');
const qrpng = require('../lib/qrpng');
const inventory = require('../lib/inventory');
// §183 — the questions a product asks (hot or iced, extra shot, sugar), shared
// with the QR menu so the counter and the phone ask the same things.
const productOptions = require('../lib/product-options');
const { requireRetailAdmin } = require('./retail');
// §289 — which rows have a photo, the same test the shop lists use.
const { hasImageFallbackSql } = require('../lib/product-image-sql');
const { logActivity } = require('../middleware/auth');

const router = express.Router();

const FULFILMENT_MODES = ['stocked', 'made_here'];

// Writes need the stores capability. req.caps is the operator's resolved set
// (routes/retail.js requireRetailAdmin attaches it); a kitchen session carries
// none, and RBAC is dark there, so a null set passes — the same shape can()
// takes in the admin. A backend operator whose set lacks stores:edit is refused.
function requireStoresEdit(req, res, next) {
  if (req.caps instanceof Set && !req.caps.has('stores:edit')) {
    return res.status(403).json({ success: false, error: 'forbidden' });
  }
  next();
}

const ok  = (res, data, status) => res.status(status || 200).json({ success: true, data });
const bad = (res, status, error, extra) => res.status(status).json({ success: false, error, ...(extra || {}) });

function intParam(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// A listing price: a finite non-negative number, rounded to the cent. Anything
// else is refused rather than coerced to 0 — a zero price on a menu is a real
// figure a customer would be charged, and it must only ever be typed on purpose.
function coercePrice(raw) {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

function coerceSort(raw) {
  if (raw == null || raw === '') return null;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// NULL-or-trimmed for the two optional display names.
function coerceName(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s ? s.slice(0, 120) : null;
}

const SHOP_SELECT = `
  SELECT s.id, s.location_id, s.public_code, s.display_name_en, s.display_name_cn,
         s.is_active, s.created_at, s.updated_at,
         l.code AS location_code, l.name_en AS location_name_en, l.name_cn AS location_name_cn,
         l.is_active AS location_is_active
    FROM shops s
    JOIN retail_stores l ON l.id = s.location_id`;

function getShop(id) {
  return tdb().prepare(SHOP_SELECT + ' WHERE s.id = ?').get(id) || null;
}

const LISTING_SELECT = `
  SELECT sl.id, sl.shop_id, sl.store_product_id, sl.price, sl.fulfilment_mode,
         sl.is_available, sl.sort_position, sl.created_at, sl.updated_at,
         p.name_en, p.name_cn, p.sku, p.sell_price,
         COALESCE(p.is_active, 1) AS product_is_active,
         COALESCE(p.is_published, 0) AS product_is_published
    FROM shop_listings sl
    JOIN store_products p ON p.id = sl.store_product_id`;

function listListings(shopId) {
  return tdb().prepare(LISTING_SELECT + ' WHERE sl.shop_id = ? ORDER BY sl.sort_position ASC, sl.id ASC').all(shopId);
}
function getListing(shopId, id) {
  return tdb().prepare(LISTING_SELECT + ' WHERE sl.shop_id = ? AND sl.id = ?').get(shopId, id) || null;
}

// MINTING A SHOP ROW, in one place. Re-rolls on a UNIQUE collision, the
// referral-code shape. Eight attempts over a 32^8 keyspace is not a real
// limit; it is there so a broken random source fails loudly rather than
// spinning.
//
// EXTRACTED FOR THE MOVE (§177), which has to create the destination's shop
// when the location has none. It calls this rather than growing a second
// minter: a code minted two ways is a code with two sets of properties, and
// §44 rests on there being one.
//
// Returns { id } or { error, status } — the caller answers with it, so a
// losing race reads identically however the insert was reached.
function mintShop(locationId, nameEn, nameCn) {
  for (let i = 0; i < 8; i++) {
    const code = newShopCode();
    try {
      const info = tdb().prepare(
        'INSERT INTO shops (location_id, public_code, display_name_en, display_name_cn) VALUES (?, ?, ?, ?)'
      ).run(locationId, code, nameEn == null ? null : nameEn, nameCn == null ? null : nameCn);
      return { id: info.lastInsertRowid };
    } catch (e) {
      // Only a public_code collision is retried. A location_id collision means
      // a concurrent create won the race — answer as the pre-check would have.
      if (/shops\.public_code/.test(e.message)) continue;
      if (/shops\.location_id/.test(e.message)) return { error: 'shop_exists', status: 409 };
      throw e;
    }
  }
  return { error: 'code_mint_failed', status: 500 };
}

// ─── Shops ──────────────────────────────────────────────────────────────

// Every location, with its shop if it has one. The Sales → Locations cards
// read this to know which card leads to a menu and which to "not set up";
// the shop page reads it to resolve a location code to a shop.
router.get('/api/retail-admin/shops', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare(`
    SELECT l.id AS location_id, l.code AS location_code, l.name_en AS location_name_en,
           l.name_cn AS location_name_cn, l.is_active AS location_is_active, l.sort_order,
           s.id AS shop_id, s.public_code, s.display_name_en, s.display_name_cn,
           s.is_active AS shop_is_active,
           (SELECT COUNT(*) FROM shop_listings sl WHERE sl.shop_id = s.id) AS listing_count,
           (SELECT COUNT(*) FROM shop_listings sl WHERE sl.shop_id = s.id AND sl.is_available = 1) AS available_count
      FROM retail_stores l
      LEFT JOIN shops s ON s.location_id = l.id
     ORDER BY l.sort_order ASC, l.id ASC
  `).all();
  ok(res, rows.map(r => ({
    location: {
      id: r.location_id, code: r.location_code, name_en: r.location_name_en,
      name_cn: r.location_name_cn, is_active: r.location_is_active,
    },
    shop: r.shop_id ? {
      id: r.shop_id, public_code: r.public_code, display_name_en: r.display_name_en,
      display_name_cn: r.display_name_cn, is_active: r.shop_is_active,
      listing_count: r.listing_count, available_count: r.available_count,
    } : null,
  })));
});

// Create the shop on a location. The code is minted here and only here.
router.post('/api/retail-admin/shops', requireRetailAdmin, requireStoresEdit, express.json(), (req, res) => {
  const b = req.body || {};
  const locationId = intParam(b.location_id);
  if (!locationId) return bad(res, 400, 'location_id_required');
  const loc = tdb().prepare('SELECT id FROM retail_stores WHERE id = ?').get(locationId);
  if (!loc) return bad(res, 404, 'location_not_found');
  if (tdb().prepare('SELECT id FROM shops WHERE location_id = ?').get(locationId)) {
    return bad(res, 409, 'shop_exists');
  }
  const nameEn = coerceName(b.display_name_en);
  const nameCn = coerceName(b.display_name_cn);

  const minted = mintShop(locationId, nameEn, nameCn);
  if (minted.error) return bad(res, minted.status, minted.error);
  const shopId = minted.id;

  logActivity(req.user.id, req.user.username, 'create', 'shop', shopId, { location_id: locationId }, req.ip);
  ok(res, { shop: getShop(shopId), listings: [] }, 201);
});

router.get('/api/retail-admin/shops/:id', requireRetailAdmin, (req, res) => {
  const id = intParam(req.params.id);
  const shop = id && getShop(id);
  if (!shop) return bad(res, 404, 'not_found');
  ok(res, { shop, listings: listListings(id) });
});

// Display names and the active flag. Never the code, never the location.
router.patch('/api/retail-admin/shops/:id', requireRetailAdmin, requireStoresEdit, express.json(), (req, res) => {
  const id = intParam(req.params.id);
  if (!id || !getShop(id)) return bad(res, 404, 'not_found');
  const b = req.body || {};
  const sets = [];
  const vals = [];
  if ('display_name_en' in b) { sets.push('display_name_en = ?'); vals.push(coerceName(b.display_name_en)); }
  if ('display_name_cn' in b) { sets.push('display_name_cn = ?'); vals.push(coerceName(b.display_name_cn)); }
  if ('is_active' in b) { sets.push('is_active = ?'); vals.push(b.is_active ? 1 : 0); }
  if (!sets.length) return bad(res, 400, 'nothing_to_update');
  vals.push(id);
  tdb().prepare(`UPDATE shops SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals);
  logActivity(req.user.id, req.user.username, 'update', 'shop', id, b, req.ip);
  ok(res, { shop: getShop(id) });
});

// MOVE A MENU TO ANOTHER LOCATION — §177 (2026-09-18, decided by Ash).
//
// THE LISTINGS MOVE; THE SHOP RECORD AND ITS CODE DO NOT. That is the whole
// shape of this route, and the never-writable list at the head of this file is
// why: `location_id` is not editable because a printed QR is a promise about
// the code attached to it. Repointing the record would have been the smaller
// diff and it is refused — it would make every QR already stuck to a table at
// the SOURCE serve the DESTINATION's menu, silently, to customers.
//
// So a move costs a reprint, by construction: the destination gets its OWN
// shop (minted here when it has none, with its own code) and the source keeps
// its code over an emptied menu. The admin says both of those out loud before
// it calls this; nothing here is reachable without that confirmation.
//
// THE SOURCE SHOP IS SWITCHED OFF, NOT DELETED. `resolveShop()` in
// routes/shop-menu.js already requires an active shop, so the old code stops
// resolving and the public page serves the same not-found page it serves a
// wrong code — no new public behaviour. Deleting the row would instead free
// the location for a shop with a NEW code and destroy the record of what the
// old one was, which is the evidence a reader needs to understand a dead QR.
//
// THE DESTINATION'S OWN SWITCH IS NOT TOUCHED. A shop that was off before the
// move is off after it, carrying its new menu; one created BY the move is
// active, because that is what creating one has always done. The answer
// carries both shops in full, so the caller can say which happened rather
// than the operator guessing whether the new menu is live.
router.post('/api/retail-admin/shops/:id/move', requireRetailAdmin, requireStoresEdit, express.json(), (req, res) => {
  const id = intParam(req.params.id);
  const from = id && getShop(id);
  if (!from) return bad(res, 404, 'not_found');

  const toLocationId = intParam((req.body || {}).to_location_id);
  if (!toLocationId) return bad(res, 400, 'to_location_id_required');
  if (toLocationId === from.location_id) return bad(res, 409, 'same_location');
  const toLoc = tdb().prepare('SELECT id FROM retail_stores WHERE id = ?').get(toLocationId);
  if (!toLoc) return bad(res, 404, 'location_not_found');

  // ALL OR NOTHING, AND THAT INCLUDES EVERY REFUSAL THAT READS THE DATA.
  //
  // A half-move — products at both locations or at neither — is the one
  // outcome an operator could not reason about from either screen, so the
  // copy, the delete, the switch and the mint are one transaction. The two
  // REFUSALS that depend on a count are inside it as well, which is not
  // tidiness: read outside, each one is a race whose loser is a corrupted
  // move rather than an error. A destination counted as empty and filled a
  // moment later would hit UNIQUE(shop_id, store_product_id) mid-copy and
  // report a 500 for a case this route has a sentence for, and a product added
  // to the SOURCE after its menu was read would be deleted without ever being
  // copied. Both are ordinary refusals from in here.
  //
  // mintShop() answers rather than throwing, so its refusal is re-thrown by
  // hand to leave the transaction the same way the others do — a shop minted
  // for a move that then failed would leave a location holding a code nobody
  // printed.
  const fail = (code, status, extra) =>
    Object.assign(new Error(code), { httpCode: code, httpStatus: status, extra });
  let toShopId = null;
  let created = false;
  let rows = [];
  const tx = tdb().transaction(() => {
    // These rows are what move. `sort_position` comes across verbatim, so the
    // menu arrives in the order it was built in rather than in insert order.
    rows = listListings(id);
    if (!rows.length) throw fail('nothing_to_move', 409);

    // REFUSED BY LISTING COUNT, NOT BY THE PRESENCE OF A SHOP (§177). Merging
    // two priced menus asks whose price wins on a product listed at both, and
    // that question is not answered here. A location set up and never filled
    // is a valid destination and its empty shop is REUSED — `location_id` is
    // UNIQUE, so a second one could not be created anyway.
    const existing = tdb().prepare('SELECT id FROM shops WHERE location_id = ?').get(toLocationId);
    if (existing) {
      const n = tdb().prepare('SELECT COUNT(*) AS n FROM shop_listings WHERE shop_id = ?').get(existing.id).n;
      if (n) throw fail('destination_has_menu', 409, { listing_count: n });
      toShopId = existing.id;
    } else {
      const minted = mintShop(toLocationId, null, null);
      if (minted.error) throw fail(minted.error, minted.status);
      toShopId = minted.id;
      created = true;
    }

    const ins = tdb().prepare(
      'INSERT INTO shop_listings (shop_id, store_product_id, price, fulfilment_mode, is_available, sort_position)'
      + ' VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const r of rows) ins.run(toShopId, r.store_product_id, r.price, r.fulfilment_mode, r.is_available, r.sort_position);
    tdb().prepare('DELETE FROM shop_listings WHERE shop_id = ?').run(id);
    tdb().prepare('UPDATE shops SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  });
  try {
    tx();
  } catch (e) {
    if (e && e.httpCode) return bad(res, e.httpStatus, e.httpCode, e.extra);
    throw e;
  }

  // Logged against BOTH shops. The source's entry is the only record of why a
  // live menu went empty and a printed code went dead; the destination's is
  // the only record of where its menu came from.
  logActivity(req.user.id, req.user.username, 'update', 'shop', id,
    { moved_to_shop_id: toShopId, moved_to_location_id: toLocationId, listings: rows.length, switched_off: true }, req.ip);
  logActivity(req.user.id, req.user.username, 'update', 'shop', toShopId,
    { moved_from_shop_id: id, moved_from_location_id: from.location_id, listings: rows.length, shop_created: created }, req.ip);

  ok(res, {
    from: getShop(id),
    to: getShop(toShopId),
    listings: listListings(toShopId),
    moved: rows.length,
    created,
  });
});


// ─── Listings ───────────────────────────────────────────────────────────

// Products that could be added: active store_products not already on this
// menu. EVERY one of them — an empty box is the whole addable catalogue.
//
// THERE IS NO CAP, and the cap it used to carry is the reason this comment is
// long. `LIMIT 50` read as "the picker never becomes the whole catalogue",
// which is a fine thing to want and the wrong way to get it: with the box
// empty the operator saw the first fifty products in alphabetical order and
// nothing said so, so a catalogue of several hundred looked like a catalogue
// of fifty that stopped somewhere in the B's. Everything past that could only
// be reached by guessing enough of its name to type, which is the opposite of
// what a list is for. Nothing here has ever filtered on stock — an out-of-stock
// product was always a candidate — but a truncated list is indistinguishable
// from a filtered one to the person reading it, and reads as "the out-of-stock
// ones are missing". The panel scrolls (retail-admin.css #shp-pick-list) so a
// long list costs height inside the card, not the page.
//
// THE SEARCH IS THE STOREFRONT'S, and deliberately so: a product the shopper
// can find in the shop must be findable by the operator putting it ON a shop.
// Two things were missing, both already settled in routes/retail.js on
// GET /api/retail/products, and both of which read as "the search is broken":
//
//  1. IT WAS ONE RAW LIKE ON THE WHOLE STRING. So "peanut butter" matched only
//     a name carrying those words in that order with exactly one space between
//     them — a trailing space, a doubled space, or the two words the other way
//     round returned nothing at all. Tokenised now: split on whitespace, every
//     token must hit one of the columns, word order irrelevant.
//  2. IT LOOKED AT name/sku ONLY. The authored keywords (the green "search
//     terms" subtitle) and the taglines are what make a Chinese-only 咖啡豆
//     findable by typing "coffee", and vice versa. They are in now.
router.get('/api/retail-admin/shops/:id/candidates', requireRetailAdmin, (req, res) => {
  const id = intParam(req.params.id);
  if (!id || !getShop(id)) return bad(res, 404, 'not_found');
  const SEARCH_COLS = ['name_en', 'name_cn', 'sku', 'keywords_en', 'keywords_cn', 'tagline_en', 'tagline_cn'];
  const terms = String(req.query.q || '').trim().split(/\s+/).filter(Boolean);
  const params = [id];
  let where = '';
  for (const t of terms) {
    where += ' AND (' + SEARCH_COLS.map(c => `p.${c} LIKE ? ESCAPE '\\'`).join(' OR ') + ')';
    // The backslash is escaped too — without it a term containing one leaves a
    // dangling escape at the end of the pattern.
    const like = '%' + t.replace(/[%_\\]/g, ch => '\\' + ch) + '%';
    for (let i = 0; i < SEARCH_COLS.length; i++) params.push(like);
  }
  // Ordered by the name the picker actually PRINTS. Sorting on name_en alone
  // put every Chinese-only product at the top in a block, under an empty sort
  // key, which is where a reader looks last.
  const rows = tdb().prepare(`
    SELECT p.id, p.name_en, p.name_cn, p.sku, p.sell_price, COALESCE(p.is_published, 0) AS is_published
      FROM store_products p
     WHERE COALESCE(p.is_active, 1) = 1
       AND p.id NOT IN (SELECT store_product_id FROM shop_listings WHERE shop_id = ?)
       ${where}
     ORDER BY COALESCE(NULLIF(p.name_en, ''), p.name_cn) COLLATE NOCASE ASC
  `).all(...params);
  ok(res, rows);
});

router.post('/api/retail-admin/shops/:id/listings', requireRetailAdmin, requireStoresEdit, express.json(), (req, res) => {
  const id = intParam(req.params.id);
  if (!id || !getShop(id)) return bad(res, 404, 'not_found');
  const b = req.body || {};
  const productId = intParam(b.store_product_id);
  if (!productId) return bad(res, 400, 'store_product_id_required');
  const p = tdb().prepare('SELECT id, sell_price FROM store_products WHERE id = ?').get(productId);
  if (!p) return bad(res, 404, 'product_not_found');

  const mode = b.fulfilment_mode == null ? 'stocked' : String(b.fulfilment_mode);
  if (!FULFILMENT_MODES.includes(mode)) return bad(res, 400, 'bad_fulfilment_mode', { allowed: FULFILMENT_MODES });

  // Price defaults to the catalogue price, and is the listing's own from then
  // on (§42: price lives on the listing). A typed price must parse.
  let price;
  if (b.price == null || b.price === '') price = coercePrice(p.sell_price) ?? 0;
  else {
    price = coercePrice(b.price);
    if (price === null) return bad(res, 400, 'bad_price');
  }

  let sort = coerceSort(b.sort_position);
  if (sort === null) {
    if (b.sort_position != null && b.sort_position !== '') return bad(res, 400, 'bad_sort_position');
    // New rows land at the end of the menu.
    const last = tdb().prepare('SELECT COALESCE(MAX(sort_position), -1) AS m FROM shop_listings WHERE shop_id = ?').get(id);
    sort = (last ? last.m : -1) + 1;
  }

  let info;
  try {
    info = tdb().prepare(
      'INSERT INTO shop_listings (shop_id, store_product_id, price, fulfilment_mode, sort_position) VALUES (?, ?, ?, ?, ?)'
    ).run(id, productId, price, mode, sort);
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return bad(res, 409, 'already_listed');
    throw e;
  }
  logActivity(req.user.id, req.user.username, 'create', 'shop_listing', info.lastInsertRowid,
    { shop_id: id, store_product_id: productId, price, fulfilment_mode: mode }, req.ip);
  ok(res, getListing(id, info.lastInsertRowid), 201);
});

// ADD EVERY ONLINE-STORE PRODUCT IN ONE GO (Ash, 2026-09-29: "make all products
// on mini app available also on the qr menu"). The same thing the per-product
// POST above does, once for each product the mini app shows — is_published and
// active, the filter GET /api/retail/products applies — that this shop does not
// list yet. Same defaults as one at a time: catalogue price, stocked, at the
// end of the menu, in the mini app's own order.
//
// §42 IS UNCHANGED BY THIS. A listing is still what puts a product on a shop's
// menu; this only writes the listings a person would otherwise add one by one.
// It is a one-off per tap, not a sync: a product published tomorrow is not
// added until someone taps again, and anything removed afterwards stays off.
router.post('/api/retail-admin/shops/:id/listings/add-published', requireRetailAdmin, requireStoresEdit, (req, res) => {
  const id = intParam(req.params.id);
  if (!id || !getShop(id)) return bad(res, 404, 'not_found');
  const db = tdb();
  let added = 0;
  db.transaction(() => {
    const todo = db.prepare(`
      SELECT p.id, p.sell_price FROM store_products p
       WHERE p.is_published = 1 AND COALESCE(p.is_active, 1) = 1
         AND p.id NOT IN (SELECT store_product_id FROM shop_listings WHERE shop_id = ?)
       ORDER BY p.sort_order ASC, p.name_en ASC, p.id ASC
    `).all(id);
    const last = db.prepare('SELECT COALESCE(MAX(sort_position), -1) AS m FROM shop_listings WHERE shop_id = ?').get(id);
    let sort = (last ? last.m : -1) + 1;
    const ins = db.prepare(
      "INSERT INTO shop_listings (shop_id, store_product_id, price, fulfilment_mode, sort_position) VALUES (?, ?, ?, 'stocked', ?)"
    );
    for (const p of todo) ins.run(id, p.id, coercePrice(p.sell_price) ?? 0, sort++);
    added = todo.length;
  })();
  if (added) {
    logActivity(req.user.id, req.user.username, 'create', 'shop_listing', id,
      { shop_id: id, added, via: 'add_published' }, req.ip);
  }
  ok(res, { added, listings: listListings(id) });
});

router.patch('/api/retail-admin/shops/:id/listings/:lid', requireRetailAdmin, requireStoresEdit, express.json(), (req, res) => {
  const id = intParam(req.params.id);
  const lid = intParam(req.params.lid);
  if (!id || !lid || !getListing(id, lid)) return bad(res, 404, 'not_found');
  const b = req.body || {};
  const sets = [];
  const vals = [];
  if ('price' in b) {
    const price = coercePrice(b.price);
    if (price === null) return bad(res, 400, 'bad_price');
    sets.push('price = ?'); vals.push(price);
  }
  if ('fulfilment_mode' in b) {
    const mode = String(b.fulfilment_mode);
    if (!FULFILMENT_MODES.includes(mode)) return bad(res, 400, 'bad_fulfilment_mode', { allowed: FULFILMENT_MODES });
    sets.push('fulfilment_mode = ?'); vals.push(mode);
  }
  if ('is_available' in b) { sets.push('is_available = ?'); vals.push(b.is_available ? 1 : 0); }
  if ('sort_position' in b) {
    const sort = coerceSort(b.sort_position);
    if (sort === null) return bad(res, 400, 'bad_sort_position');
    sets.push('sort_position = ?'); vals.push(sort);
  }
  if (!sets.length) return bad(res, 400, 'nothing_to_update');
  vals.push(id, lid);
  tdb().prepare(`UPDATE shop_listings SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE shop_id = ? AND id = ?`).run(...vals);
  logActivity(req.user.id, req.user.username, 'update', 'shop_listing', lid, b, req.ip);
  ok(res, getListing(id, lid));
});

// §287 — SOLD OUT FROM THE COUNTER. The person who finds the tomatoes gone is
// at the till, not at the office screen, so a cashier may flip a made-here
// listing's switch from there. It is the SAME column the office's "Available"
// switch writes (is_available): one switch, two places to reach it, so the
// till, the QR menu and the office can never disagree about whether the
// sour cream can be made.
//
// NARROWER THAN THE PATCH ABOVE, ON PURPOSE. That one needs stores:edit and
// can change the price; this one needs till:use (or stores:edit) and can change
// exactly one thing on exactly one kind of row. A stocked listing is refused —
// its availability is counted on the shelf, and a cashier turning it off would
// hide stock the mini app is selling (§150).
//
// It never turns itself back on (Ash, 2026-09-29): an ingredient can be out
// for days, and a switch that reset every morning would sell what cannot be
// made.
function requireTillOrStoresEdit(req, res, next) {
  if (req.caps instanceof Set && !req.caps.has('till:use') && !req.caps.has('stores:edit')) {
    return res.status(403).json({ success: false, error: 'forbidden' });
  }
  next();
}

router.put('/api/retail-admin/shops/:id/listings/:lid/sold-out', requireRetailAdmin, requireTillOrStoresEdit, express.json(), (req, res) => {
  const id = intParam(req.params.id);
  const lid = intParam(req.params.lid);
  const shop = id ? getShop(id) : null;
  const listing = shop && lid ? getListing(id, lid) : null;
  if (!listing) return bad(res, 404, 'not_found');
  // A store-scoped cashier works their own counter. The choke point cannot
  // check this — the id in the path is a shop, not a store.
  if (Array.isArray(req.scopeStores) && req.scopeStores.indexOf(shop.location_id) === -1) {
    return res.status(403).json({ success: false, error: 'forbidden_store' });
  }
  if (listing.fulfilment_mode !== 'made_here') return bad(res, 409, 'not_made_here');
  const b = req.body || {};
  if (typeof b.sold_out !== 'boolean') return bad(res, 400, 'sold_out_required');
  const avail = b.sold_out ? 0 : 1;
  tdb().prepare('UPDATE shop_listings SET is_available = ?, updated_at = CURRENT_TIMESTAMP WHERE shop_id = ? AND id = ?')
    .run(avail, id, lid);
  logActivity(req.user.id, req.user.username, 'update', 'shop_listing', lid,
    { shop_id: id, is_available: avail, via: 'till_sold_out' }, req.ip);
  ok(res, { listing_id: lid, sold_out: b.sold_out });
});

// Re-sequence the whole menu in one write: ids in the order they should read.
// Ids not on this shop are ignored rather than refused, so a stale client that
// still names a just-removed row cannot block the reorder of the rest.
router.post('/api/retail-admin/shops/:id/listings/reorder', requireRetailAdmin, requireStoresEdit, express.json(), (req, res) => {
  const id = intParam(req.params.id);
  if (!id || !getShop(id)) return bad(res, 404, 'not_found');
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(intParam).filter(Boolean) : null;
  if (!ids || !ids.length) return bad(res, 400, 'ids_required');
  const upd = tdb().prepare('UPDATE shop_listings SET sort_position = ?, updated_at = CURRENT_TIMESTAMP WHERE shop_id = ? AND id = ?');
  tdb().transaction(() => { ids.forEach((lid, i) => upd.run(i, id, lid)); })();
  ok(res, listListings(id));
});

// A listing is a join, not history: nothing references it yet, so removing it
// is a delete, and the product is available to add again.
router.delete('/api/retail-admin/shops/:id/listings/:lid', requireRetailAdmin, requireStoresEdit, (req, res) => {
  const id = intParam(req.params.id);
  const lid = intParam(req.params.lid);
  if (!id || !lid) return bad(res, 404, 'not_found');
  const r = tdb().prepare('DELETE FROM shop_listings WHERE shop_id = ? AND id = ?').run(id, lid);
  if (!r.changes) return bad(res, 404, 'not_found');
  logActivity(req.user.id, req.user.username, 'delete', 'shop_listing', lid, { shop_id: id }, req.ip);
  ok(res, { removed: lid });
});

// ─── The shop's QR ──────────────────────────────────────────────────────

// What a scan opens, and whether we can say. Read by the shop screen so it can
// show the operator the actual address before anything is printed — a QR is
// opaque to a human, and an operator who cannot read what it says cannot catch
// it being wrong.
router.get('/api/retail-admin/shops/:id/qr', requireRetailAdmin, (req, res) => {
  const id = intParam(req.params.id);
  const shop = id && getShop(id);
  if (!shop) return bad(res, 404, 'not_found');
  const url = menuUrlFor(currentTenantId(), shop.public_code);
  // no_public_domain is a real answer, not an error: this tenant has not told
  // the platform where it serves customers, so nobody can say what a scan
  // should open. Named so the screen can explain it rather than print "failed".
  if (!url) return ok(res, { url: null, reason: 'no_public_domain' });
  ok(res, { url });
});

// The picture itself. PNG bytes, so the operator can save, print or drop it
// into a poster without the browser re-encoding anything.
//
// NOT CACHED. A shop's code never changes, but the DOMAIN it is minted against
// can — a tenant moves to its own domain and every QR minted before that points
// somewhere it no longer controls. A stale cached image is a sticker printed
// against yesterday's answer, so this is always recomputed.
router.get('/api/retail-admin/shops/:id/qr.png', requireRetailAdmin, (req, res) => {
  const id = intParam(req.params.id);
  const shop = id && getShop(id);
  if (!shop) return res.status(404).end();
  const url = menuUrlFor(currentTenantId(), shop.public_code);
  if (!url) return bad(res, 409, 'no_public_domain');
  // Scale is the module width in pixels. 8 is the on-screen size; the download
  // asks for more, because a QR that is printed and stuck to a table is
  // resampled by whatever prints it and a small source shows it. Clamped rather
  // than trusted: an unbounded scale is an easy way to ask this endpoint for a
  // hundred-megabyte PNG.
  const scale = Math.max(4, Math.min(24, parseInt(req.query.scale, 10) || 8));
  // A filename the operator can find again in a downloads folder six weeks
  // later. The code is the only stable, human-checkable thing about a QR.
  if (req.query.download === '1') {
    res.set('Content-Disposition', `attachment; filename="shop-${shop.public_code}.png"`);
  }
  let png;
  try { png = qrpng.qrPng(url, { scale, quiet: 4 }); }
  catch (e) {
    // lib/qrpng carries versions 1-6, about 103 bytes. A customer domain long
    // enough to overflow that is possible and must say so rather than 500.
    console.error('[shop-qr]', shop.public_code, e.message);
    return bad(res, 422, 'url_too_long_for_qr', { length: url.length });
  }
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(png);
});

// ─── Which shop menus carry one product ─────────────────────────────────
//
// THE QUESTION THE PRODUCT PAGE EDITOR COULD NOT ASK. Every route above is
// shop-first — give me a shop, here are its products — because that is how the
// menu is composed. The editor arrives from the other side, holding one product
// and needing to know where a customer can already see it, and answering that
// by walking every shop's listings is N requests to count to three.
//
// IT LIVES IN THIS FILE ON PURPOSE. shop_listings is read here and in the
// public menu and nowhere else, a containment scripts/test_shop_listings.js
// holds by walking routes/, lib/, middleware/ and public/ for the table's name.
// A reader in the editor's own file would have widened that allowlist; a reader
// here widens nothing. The editor fetches this route and never names the table.
//
// IT ANSWERS FOR THE WHOLE VARIANT FAMILY, because the menu does. The QR page
// collapses siblings into one card (routes/shop-menu.js, §129), so a 250g jar
// listed at a shop puts the family on that menu — and the editor, which also
// collapses variants in its switcher, would otherwise report "on no menu" while
// standing on the 500g of something a customer is looking at.
//
// tenant_has_shops is a separate fact from an empty list, and both are said.
// No shops at all means the module was never set up and the editor should not
// draw the count; shops that exist but do not carry this product is a zero
// worth showing, and is exactly the state that made a Draft badge confusing.
router.get('/api/retail-admin/products/:id/shops', requireRetailAdmin, (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return bad(res, 404, 'not_found');
  const product = tdb().prepare(
    'SELECT id, variant_group_id FROM store_products WHERE id = ? AND COALESCE(is_active, 1) = 1'
  ).get(id);
  if (!product) return bad(res, 404, 'not_found');

  const family = product.variant_group_id
    ? tdb().prepare(
        'SELECT id FROM store_products WHERE variant_group_id = ? AND COALESCE(is_active, 1) = 1'
      ).all(product.variant_group_id).map(r => r.id)
    : [id];
  const ids = family.length ? family : [id];
  const ph = ids.map(() => '?').join(',');

  const tenantHasShops = tdb().prepare('SELECT COUNT(*) AS n FROM shops').get().n > 0;
  const rows = tdb().prepare(`
    SELECT s.id AS shop_id, s.public_code,
           s.display_name_en, s.display_name_cn,
           s.is_active AS shop_is_active,
           l.name_en AS location_name_en, l.name_cn AS location_name_cn,
           COALESCE(l.is_active, 1) AS location_is_active,
           MAX(CASE WHEN sl.store_product_id = ? THEN 1 ELSE 0 END) AS lists_this_product,
           MAX(sl.is_available) AS is_available
      FROM shop_listings sl
      JOIN shops s         ON s.id = sl.shop_id
      JOIN retail_stores l ON l.id = s.location_id
     WHERE sl.store_product_id IN (${ph})
     GROUP BY s.id
     ORDER BY l.sort_order ASC, s.id ASC
  `).all(id, ...ids);

  ok(res, {
    tenant_has_shops: tenantHasShops,
    // A scan reaches the menu only when the shop AND its location are both on —
    // the /s/:shopCode page answers its empty page otherwise — so "a customer
    // can see this" is not the same count as "a listing exists".
    shops: rows.map(r => ({
      shop_id: r.shop_id,
      public_code: r.public_code,
      display_name_en: r.display_name_en,
      display_name_cn: r.display_name_cn,
      location_name_en: r.location_name_en,
      location_name_cn: r.location_name_cn,
      reachable: !!(r.shop_is_active && r.location_is_active),
      // false when only a SIBLING size is listed here — the family is on this
      // menu, this exact row is not, and the two are different answers.
      lists_this_product: !!r.lists_this_product,
      is_available: !!r.is_available,
    })),
  });
});

// Which products stand on at least one QR menu — Products → Categories draws
// only these in its QR menu view, where dragging sets the QR menu's product
// order (lib/qr-menu-category-order.js `products`). One list for the tenant,
// because that order is one value for every location. It lives in this file
// for the reason /products/:id/shops gives above: a reader anywhere else would
// widen the shop_listings containment allowlist.
router.get('/api/retail-admin/shop-listings/product-ids', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare('SELECT DISTINCT store_product_id AS id FROM shop_listings').all();
  ok(res, rows.map(r => r.id));
});

// ─── What the counter may sell — §150 ───────────────────────────────────
// THE COUNTER SELLS WHAT THE SHOP PHYSICALLY HAS, PLUS WHAT THE SHOP MAKES.
// Reported by Ash from a Tianhe till: a product listed on that location's menu
// could not be found in the till's search at all.
//
// The till used to build its list from `/api/retail-admin/products?published=1`
// — the ONLINE STORE flag. §42 draws the line the other way round and the public
// menu has always honoured it: is_published governs the website, a shop listing
// governs the shop. Nothing made at a location is ever sold on a website, so
// nothing made at a location was ever ticked published, so nothing made at a
// location reached the counter. A latte was invisible to the cashier standing
// next to the machine that makes it.
//
// THREE SOURCES, ONE LIST, and the middle one is the fix:
//   1. Anything on this location's menu, at ITS price (§42: the price lives on
//      the listing). A made-here row carries no shelf record by design, so its
//      stock comes back null and the till never gates it — §47 says the manual
//      switch is the whole of its availability, and `is_available = 0` is
//      therefore absent from this list rather than shown greyed.
//   2. Anything with counted stock at this location, published or not. A box
//      somebody put on a shelf here is sellable at the counter in front of it;
//      whether the website offers it is a different question that was never
//      being asked.
//   3. Everything the till already showed — published, priced, in or out of
//      stock. Named explicitly so this change is additive and no tile that a
//      cashier can see today disappears.
//
// A LISTING GOVERNS ITS PRODUCT ABSOLUTELY. Where a listing exists, it decides
// the price, the mode and whether the row appears at all — a product switched
// off for the day must not reappear two rows down at the catalogue price, which
// is what "menu first, then the catalogue" would do if the two halves were
// merely concatenated.
//
// IT LIVES IN THIS FILE for the reason /products/:id/shops gives above: a
// reader in public/till.html or routes/retail-inventory.js would have widened
// the containment allowlist, and a reader here widens nothing.
//
// SHOP is_active IS DELIBERATELY NOT CONSULTED. It governs the /s/:shopCode
// page — switching the QR menu off is a statement about a public URL, not about
// whether the counter can ring up a coffee. The till has its own closed-store
// gate (posClosedForStore) and it is unchanged.
router.get('/api/retail-admin/stores/:id/counter-catalogue', requireRetailAdmin, (req, res) => {
  const locationId = intParam(req.params.id);
  if (!locationId) return bad(res, 404, 'store_not_found');
  const loc = tdb().prepare('SELECT id FROM retail_stores WHERE id = ?').get(locationId);
  if (!loc) return bad(res, 404, 'store_not_found');

  const shop = tdb().prepare('SELECT id FROM shops WHERE location_id = ?').get(locationId) || null;
  const listings = shop
    ? tdb().prepare(`
        SELECT id, store_product_id, price, fulfilment_mode, is_available, sort_position
          FROM shop_listings WHERE shop_id = ?`).all(shop.id)
    : [];
  const byProduct = new Map(listings.map(l => [l.store_product_id, l]));

  // The same figure the till drew before: availability on the wechat channel,
  // which nets the safety buffer and live holds off the shelf. Absent from the
  // map means this location has never counted the product — which §47 reads as
  // no claim rather than a smaller one, so it is not stock the counter may sell
  // against. It is still the number 0 on the glass.
  const avail = inventory.getAvailableMap(locationId);

  // §183 — THE SIZE IS READ, and the omission is the whole of the first half of
  // the bug. Variants are independent product rows linked by variant_group_id,
  // so a drink sold in two sizes is two rows carrying the SAME name_en and
  // name_cn. This query never read variant_label, so the till drew two tiles
  // reading "Latte" and "Latte" at two prices with the size written nowhere,
  // and a cashier could tell them apart only by guessing at the money. §129
  // found and fixed exactly this on the QR menu; the counter kept it.
  //
  // variant_sort is the operator's own drag-to-reorder position in the back
  // office and is what keeps Regular before Large on the glass.
  const products = tdb().prepare(`
    SELECT id, name_en, name_cn, sku, top_category, sell_price,
           variant_group_id, variant_label, variant_label_cn, variant_sort,
           COALESCE(is_published, 0)    AS is_published,
           COALESCE(is_restock_only, 0) AS is_restock_only,
           updated_at, ${hasImageFallbackSql('store_products')} AS has_image
      FROM store_products
     WHERE COALESCE(is_active, 1) = 1
     ORDER BY COALESCE(NULLIF(name_en, ''), name_cn) COLLATE NOCASE ASC,
              COALESCE(variant_sort, 0) ASC, id ASC`).all();

  const rows = [];
  for (const p of products) {
    // A restock-only product is a receiving record, never a thing to sell. The
    // till filtered these out client-side and the filter moves here with it.
    if (p.is_restock_only) continue;
    const listed = byProduct.get(p.id) || null;
    const counted = avail.get(p.id) || null;
    const onShelf = counted ? Number(counted.available) || 0 : null;

    let price, mode, stock;
    let soldOut = false;
    if (listed) {
      mode  = listed.fulfilment_mode;
      // §287 — A MADE-HERE ROW SWITCHED OFF IS SOLD OUT, NOT GONE. The switch
      // is the whole of its availability (§42, §47), and switched off it means
      // "we cannot make it right now" — the tomatoes ran out. The tile stays
      // on the glass, greyed, so a cashier asked for it can say so instead of
      // hunting for a product that seems never to have existed, and can switch
      // it back from the till. A stocked row switched off is still absent: its
      // stock is counted, and §150's reason for hiding it is unchanged.
      if (!listed.is_available && mode !== 'made_here') continue;
      soldOut = mode === 'made_here' && !listed.is_available;
      price = Number(listed.price) || 0;
      // Made here: built at the moment of sale, so there is no shelf to run out
      // of and null tells the till not to draw one. Sold out is 0 — the one
      // "cannot sell this" the till's tiles already draw.
      stock = mode === 'made_here' ? (soldOut ? 0 : null) : (onShelf == null ? 0 : onShelf);
    } else {
      price = Number(p.sell_price) || 0;
      mode  = null;
      stock = onShelf == null ? 0 : onShelf;
      // Source 2 and source 3. A product that is neither published nor counted
      // here is in this tenant's catalogue and not in this shop, and a price of
      // zero is not a price — both were already excluded and stay excluded.
      if (!(price > 0)) continue;
      if (!p.is_published && !(onShelf != null && onShelf > 0)) continue;
    }

    rows.push({
      product_id: p.id,
      name_en: p.name_en, name_cn: p.name_cn, sku: p.sku,
      // Null on a product that has no siblings, which is most of them — the
      // till prints the label only when there is one, so an ordinary product
      // gains no stray separator.
      variant_label: p.variant_label || null,
      variant_label_cn: p.variant_label_cn || null,
      variant_group_id: p.variant_group_id || null,
      top_category: p.top_category,
      // §289 — THE PHOTO ON THE TILE. A small thumbnail URL, or null when
      // neither this product nor a variant sibling has one. The admin route,
      // not the public one: the till sells products that were never published
      // (§150) and the public route refuses those. 200px wide: the tile shows
      // it at about 72px, so this is sharp on a 2x screen. ?v busts the
      // browser's cache when the photo changes.
      image: p.has_image
        ? `/api/retail-admin/products/${p.id}/image?w=200&v=${encodeURIComponent(p.updated_at || '')}`
        : null,
      price,
      // The till posts unit_price on these and only these: the listing price is
      // the only price the order endpoint cannot resolve for itself, and a till
      // that posted its own figure for everything would charge a stale one every
      // time the office corrected a catalogue price.
      on_menu: !!listed,
      // §287 — what the till's Sold out control writes to. Null off the menu:
      // only a listing has a switch.
      listing_id: listed ? listed.id : null,
      fulfilment_mode: mode,
      // §287 — the made-here switch is off. Distinct from stock 0, which a
      // required question with no answer left can also produce (below): only
      // this one is a switch a cashier can turn back on.
      switched_off: soldOut,
      // null = nothing to count (made here). A number = the shelf, already net.
      stock,
      sort_position: listed ? listed.sort_position : null,
    });
  }

  // Menu first, in the order the operator arranged it, because that is the list
  // a cashier reaches for most; then the shelf, by the name the tile prints.
  rows.sort((a, b) => {
    if (a.on_menu !== b.on_menu) return a.on_menu ? -1 : 1;
    if (a.on_menu) return (a.sort_position - b.sort_position) || (a.product_id - b.product_id);
    return 0;                                   // already name-ordered by SQL
  });

  /* §183 — THE QUESTIONS THE COUNTER WOULD HAVE ASKED, which until now only the
     QR menu could ask (§120). Hot or iced, extra shot, how much sugar: rows in
     retail_product_options + retail_product_option_choices, read here by the
     same module routes/shop-menu.js reads them with, so the counter and the
     phone ask the same questions in the same order with the same limits.

     THE SHELF IS THIS LOCATION'S, and it is the same `avail` map the tiles are
     already gated by — one read, both jobs. §47 governs the verdict: an absent
     shelf record IS sold out, not "untracked", so an oat milk nobody has ever
     counted here is greyed in the sheet rather than sold blind.

     ASKED OF THE ROWS THAT SURVIVED, not of the whole catalogue. A product the
     loop above dropped — restock-only, switched off for the day, unpriced — is
     not on the glass and its questions are nobody's business. */
  const rowByProduct = new Map(rows.map(r => [r.product_id, r]));
  if (rowByProduct.size) {
    // `avail` is the map the tiles above are already gated by — the same
    // figure, read once. A second call here would ask this location the same
    // question twice and could answer it differently under load.
    const isChoiceSoldOut = (c) => {
      const a = avail.get(c.stock_product_id);
      return !a || a.available <= 0;            // absent shelf record IS sold out — §47
    };
    // withStockLink: the till mirrors this location's shelf locally between
    // catalogue reads, so an extra that is ALSO sold as a product of its own
    // has a tile here to keep honest after a sale. This is a staff endpoint
    // behind requireRetailAdmin; the public QR menu asks for no such thing.
    const byProduct = productOptions.questionsForProducts(
      tdb(), [...rowByProduct.keys()], { isChoiceSoldOut, withStockLink: true }
    );
    for (const [pid, qs] of byProduct) {
      const row = rowByProduct.get(pid);
      if (!row || !qs.length) continue;
      row.options = qs;
      // A REQUIRED QUESTION WITH NO ANSWER LEFT TAKES THE PRODUCT WITH IT —
      // §120's rule 1A, which the QR menu already obeys. A drink whose required
      // "milk?" has run out of every milk cannot be made, and the honest answer
      // on a tile is the sold-out state it already knows how to draw, not a
      // sheet the cashier cannot satisfy. Expressed as a zero shelf because
      // that is the only "cannot sell this" the till's tiles understand, and a
      // made-here row (stock null) would otherwise never gate at all.
      if (productOptions.requiredQuestionIsUnanswerable(qs)) row.stock = 0;
    }
  }

  ok(res, { has_shop: !!shop, shop_id: shop ? shop.id : null, rows });
});

module.exports = router;
module.exports.FULFILMENT_MODES = FULFILMENT_MODES;
