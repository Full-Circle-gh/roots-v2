// One shipping setting per product, not per size — §374.
//
// THE TRAP. Every size of a product is its own store_products row, and each
// row carried its own ship_modes. The Shipping chips on the product page
// (desktop and phone) PATCH only the size that is open, so a product could read
// *Land* on the size you looked at while another size still said *Air only*.
// Checkout snapshots the line's OWN row onto the order, and planShipments puts
// an "Air only" line in an Air parcel, so the customer's size flew while the
// page said Land. Found on TC000899 (Misfit Medjool Dates), 2026-10-01.
//
// THE RULE. A write of ship_modes to one size is a write to the whole family:
// every other active size gets the same value. A lone product (no
// variant_group_id) is a family of one. This is the same reading "Local only"
// already had at checkout (filterLocalOnly: "Ship restrictions are a property
// of the product, not the individual size/option") — Air and Land now match it.
//
// Orders already placed are NOT touched: their lines keep the snapshot taken at
// checkout, which is how a past order's fulfilment is meant to stay fixed.
'use strict';

// Copy `shipModes` (already normalised by the caller) from product `id` to
// every other active size in its family. Returns the ids written. Sizes that
// already agree are not rewritten. `beforeWrite(id)`, when given, runs just
// before a row is written — where the route takes the pre-edit version
// snapshot, as the PATCH does for the size it was called on.
function syncFamilyShipModes(db, id, shipModes, beforeWrite) {
  const self = db.prepare(
    'SELECT variant_group_id FROM store_products WHERE id = ?'
  ).get(id);
  if (!self || !self.variant_group_id) return [];
  const others = db.prepare(
    `SELECT id FROM store_products
      WHERE variant_group_id = ? AND id != ? AND COALESCE(is_active, 1) = 1
        AND COALESCE(ship_modes, '') != ?
      ORDER BY id`
  ).all(self.variant_group_id, id, shipModes);
  if (!others.length) return [];
  const upd = db.prepare(
    'UPDATE store_products SET ship_modes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  );
  const written = [];
  db.transaction(() => {
    for (const o of others) {
      if (beforeWrite) beforeWrite(o.id);
      upd.run(shipModes, o.id);
      written.push(o.id);
    }
  })();
  return written;
}

module.exports = { syncFamilyShipModes };
