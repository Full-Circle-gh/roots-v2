'use strict';
// A PICTURE ON EACH CHOICE, taken from the product it is linked to.
//
// Ash, 2026-10-05, on a product's paid extras: *"i want the customer to see a
// picture of each item when he make the choice"*. A choice has no photo of its
// own. What a paid extra usually has is a stock_product_id — the 🔗 link the
// editor draws, so the extra draws from that product's shelf — and that product
// already has a photo. So the picture a customer sees beside "Mango Bites" is
// the Mango Protein Bites product photo, and nobody uploads anything.
//
// THE PHOTO IS SERVED BY CHOICE ID, NEVER BY THE LINKED PRODUCT'S ID. The
// product behind an extra is often unpublished on purpose (it is a component,
// not something sold on its own), and the public product image route refuses
// unpublished products. Publishing it to get the photo would put it in the shop
// as a product of its own. The choice routes instead gate on the PARENT product
// being public, which is the page the customer is already looking at. It also
// keeps the internal product id off the QR menu's public payload, which
// lib/product-options.js deliberately leaves out.
//
// A choice with no link, or linked to a product nobody photographed, gets no
// picture. Absent means "no photo", and the clients draw the row as before.

const { hasImageFallbackSql } = require('./product-image-sql');

// Map<choice_id, version string> for each choice whose linked product has a
// photo (its own, or a variant sibling's, the same fallback the image route
// resolves). The version is the linked product's updated_at, so replacing that
// photo busts the cached copy exactly as it does for the product itself.
function choicePhotoVersions(handle, choiceIds) {
  const out = new Map();
  const ids = [...new Set((choiceIds || []).map(n => parseInt(n, 10)).filter(Boolean))];
  if (!ids.length) return out;
  const rows = handle.prepare(
    `SELECT c.id, sp.updated_at AS v
       FROM retail_product_option_choices c
       JOIN store_products sp ON sp.id = c.stock_product_id
      WHERE c.id IN (${ids.map(() => '?').join(',')})
        AND ${hasImageFallbackSql('sp')}`
  ).all(...ids);
  for (const r of rows) out.set(r.id, String(r.v || ''));
  return out;
}

module.exports = { choicePhotoVersions };
