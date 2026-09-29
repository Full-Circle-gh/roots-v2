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

module.exports = { hasImageFallbackSql };
