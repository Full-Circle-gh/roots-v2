'use strict';

// ONE ANSWER SWITCHED OFF AT ONE SHOP (§492).
//
// "Whole wheat crackers" in a made-here Hummus Platter comes out of a kitchen
// container, not off a counted shelf, so §120's stock link can never say it has
// run out. A row in `shop_option_choices_off` says it has, for one shop. This
// file is the only reader and writer of that table; lib/product-options.js
// stays free of it and takes the verdict as a caller-supplied predicate, the
// same way it takes the shelf's.
//
// THE KEY IS THE ANSWER'S LABEL within its product, never its choice id: every
// product save re-inserts the choices with new ids, and a switch keyed on an id
// would turn itself back on at the next edit. Two questions on one product that
// offer the same answer are the same crackers out of the same container, so one
// switch covers both.

// The label a choice is switched off by. label_en, or label_cn when there is
// no English — the same fallback every client prints a choice by.
function labelOf(c) {
  const en = String((c && c.label_en) || '').trim();
  return en || String((c && c.label_cn) || '').trim();
}

// `(choice) => boolean` for the shop at this location. `choice` must carry
// product_id, label_en and label_cn. Read once, lazily, on the first question:
// a menu with no options costs no query at all.
//
// No location, or a location with no shop, switches nothing off.
function switchedOffAt(handle, locationId) {
  let keys = null;
  return (c) => {
    if (!locationId) return false;
    if (keys === null) {
      keys = new Set(handle.prepare(
        `SELECT x.store_product_id, x.label
           FROM shop_option_choices_off x
           JOIN shops s ON s.id = x.shop_id
          WHERE s.location_id = ?`
      ).all(locationId).map(r => `${r.store_product_id}|${r.label}`));
    }
    if (!keys.size) return false;
    const label = labelOf(c);
    return !!label && keys.has(`${c.product_id}|${label}`);
  };
}

// Switch one answer off (off=true) or back on, for one shop. Idempotent both
// ways: switching off what is already off keeps the first stamp.
function setSwitchedOff(handle, { shopId, productId, label, off, userId = null }) {
  if (off) {
    handle.prepare(
      `INSERT OR IGNORE INTO shop_option_choices_off (shop_id, store_product_id, label, switched_off_by)
       VALUES (?, ?, ?, ?)`
    ).run(shopId, productId, label, userId);
  } else {
    handle.prepare(
      'DELETE FROM shop_option_choices_off WHERE shop_id = ? AND store_product_id = ? AND label = ?'
    ).run(shopId, productId, label);
  }
}

// A product leaving a shop's menu takes its switches with it, so putting it
// back later does not bring back an "off" nobody remembers setting.
function clearForProduct(handle, shopId, productId) {
  handle.prepare('DELETE FROM shop_option_choices_off WHERE shop_id = ? AND store_product_id = ?')
    .run(shopId, productId);
}

module.exports = { labelOf, switchedOffAt, setSwitchedOff, clearForProduct };
