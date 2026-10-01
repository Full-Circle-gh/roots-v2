## §NEW — A NEW PRODUCT KEEPS ITS COST, LOW-STOCK LINE AND BATCH FLAG ON ITS FIRST SAVE

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
When the desktop product drawer saves a new product for the first time, it sends
`POST /products` with every field on the form (`09-products.js` `pdCollectBody`).
The create stored most of them, but dropped four:
- the cost (`unit_cost`);
- the operator's "this cost is not the whole cost" tag (`cost_incomplete`);
- the low-stock line (`low_stock_threshold`);
- "made in fresh batches" (`is_batch_made`).

They reached the database only on the next autosave, which is a `PATCH`. An
operator who closed the drawer before that lost them.

1. **The create now stores the four, with exactly the PATCH's rules:**
   - **Permission first.** For an operator who cannot see costs, the cost and its
     tag are removed from the request before anything is read, by the PATCH's own
     guard (`stripProductCostWrites`). A hidden field's blank value cannot wipe or
     set anything.
   - **Cost.** Only a positive number is kept. Anything else is stored as unknown
     (NULL), never 0, because 0 would show a 100% margin. A new product has no
     recipe and no bundle components yet, so the PATCH's two cases where the cost
     is worked out from those cannot apply.
   - **The tag and "made in batches".** 1 or 0.
   - **Low-stock line.** A whole number of 0 or more. Anything else is stored as
     NULL, which means "use the shop-wide line".
   - **A field that is not sent** keeps the column's own default, as before:
     no cost, no tag, the shop-wide line, not batch-made.
   - **The reply** now carries the stored values. As with every product read, the
     cost is removed for an operator who may not see costs.
2. **Not changed:**
   - **The phone (PD12).** After its create it sends a PATCH carrying these same
     fields. That PATCH is now redundant but harmless: it writes the same values
     through the same rules. It is left as it is, as asked.
   - **The phone's create test.** It reads this handler's list of stored fields,
     and now finds the four there.
   - **The desktop wizard** sends none of the four, so nothing changes for it.
   - **The spreadsheet import** goes through this create too. A cost, low-stock
     or batch column in an imported row is now stored at creation, under the same
     rules, where before it was dropped.
3. **Tests.** `scripts/test_product_create_fields.js` (fast shard, 26 checks) runs
   the real router over a scratch database. It checks:
   - **The drawer's first save** stores all four and returns them.
   - **Same results as the PATCH**, for 14 inputs: zero, negative, blank and
     non-number costs, a cost sent as text, both tags, blank, negative,
     non-number, text and zero low-stock lines, and both batch values. Each is
     sent through the create and through a PATCH, and the two stored results must
     match.
   - **Fields not sent** keep their defaults.
   - **An operator without `products:costs`** stores no cost and no tag, but does
     store the other two, and gets no cost back.
   - **The INSERT itself** lists the four columns, with one value per column.
4. **Nothing composed.** No operator strings were added.
