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
// READ BY NOTHING ELSE. The till and every order path are unchanged by this
// file — shop_listings is written here and read here, and by nothing else in
// the repo. scripts/test_shop_listings.js holds that line.
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
const { requireRetailAdmin } = require('./retail');
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

  // Re-roll on a UNIQUE collision, the referral-code shape. Eight attempts over
  // a 32^8 keyspace is not a real limit; it is there so a broken random source
  // fails loudly rather than spinning.
  let shopId = null;
  for (let i = 0; i < 8 && shopId === null; i++) {
    const code = newShopCode();
    try {
      const info = tdb().prepare(
        'INSERT INTO shops (location_id, public_code, display_name_en, display_name_cn) VALUES (?, ?, ?, ?)'
      ).run(locationId, code, nameEn, nameCn);
      shopId = info.lastInsertRowid;
    } catch (e) {
      // Only a public_code collision is retried. A location_id collision means
      // a concurrent create won the race — answer as the pre-check would have.
      if (/shops\.public_code/.test(e.message)) continue;
      if (/shops\.location_id/.test(e.message)) return bad(res, 409, 'shop_exists');
      throw e;
    }
  }
  if (shopId === null) return bad(res, 500, 'code_mint_failed');

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

// ─── Listings ───────────────────────────────────────────────────────────

// Products that could be added: active store_products not already on this
// menu. Searched by either name or SKU, capped so the picker never becomes the
// whole catalogue.
router.get('/api/retail-admin/shops/:id/candidates', requireRetailAdmin, (req, res) => {
  const id = intParam(req.params.id);
  if (!id || !getShop(id)) return bad(res, 404, 'not_found');
  const q = String(req.query.q || '').trim();
  const params = [id];
  let where = '';
  if (q) {
    const like = '%' + q.replace(/[%_]/g, ch => '\\' + ch) + '%';
    where = " AND (p.name_en LIKE ? ESCAPE '\\' OR p.name_cn LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\')";
    params.push(like, like, like);
  }
  const rows = tdb().prepare(`
    SELECT p.id, p.name_en, p.name_cn, p.sku, p.sell_price, COALESCE(p.is_published, 0) AS is_published
      FROM store_products p
     WHERE COALESCE(p.is_active, 1) = 1
       AND p.id NOT IN (SELECT store_product_id FROM shop_listings WHERE shop_id = ?)
       ${where}
     ORDER BY p.name_en COLLATE NOCASE ASC
     LIMIT 50
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
  // Scale is the module width in pixels. 8 gives a ~300px image for the
  // versions these URLs need — big enough to print at table-tent size without
  // resampling, small enough to sit in the admin beside the code.
  let png;
  try { png = qrpng.qrPng(url, { scale: 8, quiet: 4 }); }
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

module.exports = router;
module.exports.FULFILMENT_MODES = FULFILMENT_MODES;
