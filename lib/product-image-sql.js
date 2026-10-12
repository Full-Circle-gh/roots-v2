'use strict';
// Does a product have a photo to show? Moved out of routes/retail.js (§289) so
// the till's counter catalogue in routes/retail-shops.js can ask the same
// question the shop lists ask — and so the test suites that stand in for
// routes/retail.js with a stub do not lose it.
//
// SQL flag (1 when this row OR an active variant sibling has any stored photo),
// matching resolveProductImage()'s "fallback when empty" in routes/retail.js.
// Pass the products-table alias used in the surrounding query.
function hasImageFallbackSql(alias) {
  return `(
    (${alias}.image_data IS NOT NULL AND ${alias}.image_data != '')
    OR (${alias}.image_url IS NOT NULL AND ${alias}.image_url != '')
    OR (${alias}.variant_group_id IS NOT NULL AND EXISTS(
         SELECT 1 FROM store_products vsib
          WHERE vsib.variant_group_id = ${alias}.variant_group_id
            AND COALESCE(vsib.is_active, 1) = 1
            AND ((vsib.image_data IS NOT NULL AND vsib.image_data != '')
              OR (vsib.image_url IS NOT NULL AND vsib.image_url != ''))))
  )`;
}

// A size with no photo of its own shows a sibling's, but every photo link
// carries the size's OWN updated_at as its version (?v=), and the image route
// answers that version from a year-long immutable cache. So when the sibling's
// photo changed, the borrowing size kept its old link and every phone kept the
// old picture — the shop's "2 sizes" card showed a photo the operator had
// already deleted. Call this after any write that can change which photo a
// borrowing size resolves to (a photo save, a version restore, a delete): it
// re-stamps the photo-less active siblings, so every link to them moves on.
// The row itself is not touched; its own write already stamped it.
function touchPhotoBorrowers(db, id) {
  return db.prepare(
    `UPDATE store_products SET updated_at = CURRENT_TIMESTAMP
      WHERE variant_group_id = (SELECT variant_group_id FROM store_products WHERE id = ?)
        AND id != ?
        AND COALESCE(is_active, 1) = 1
        AND (image_data IS NULL OR image_data = '')
        AND (image_url  IS NULL OR image_url  = '')`
  ).run(id, id).changes;
}

module.exports = { hasImageFallbackSql, touchPhotoBorrowers };
