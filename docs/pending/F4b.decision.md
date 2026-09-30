## §NEW — UPLOADING A 发票 FILE NEEDS A PERMISSION ON THE SERVER

**Built 2026-09-30 under §300** (Ash: *"yes , and keep going until you finish all .I approve all"*).
Found while building F4. `POST /api/retail-admin/invoice-file` stores the PDF or photo of an
issued fapiao and returns the address that Mark issued then attaches to the order. It matched
no rule in `lib/cap-routes.js`, because `invoice-file` does not start with `invoices`, so it
was an unmapped write and fell through open: any signed-in operator could store a file there,
whether or not enforcement was on. It now needs `invoices:manage` **or** `orders:edit`.

1. **Why any-of, not `invoices:manage` alone.** The builder first gated it on
   `invoices:manage` ("Issue / upload invoices" in the role editor). That would have taken the
   upload away from the `staff` and `dispatch` presets, which hold `orders:edit` without it and
   can upload today. The coordinating session narrowed the change rather than remove working
   access overnight: the upload is the first half of issuing, so it takes the same key as Mark
   issued (`PUT /orders/:id/invoice`, `orders:edit`) or the invoices key. What this closes is an
   account that holds neither.
2. **Every caller was checked.** Exactly two: the desktop order drawer's PDF / image button
   (`07-content-billing.js`, `uploadInvoicePdf`) and the phone order sheet's (`m.html`,
   `invFile`, §314). The phone draws its button only for `invoices:manage` together with
   `orders:edit`.
3. **Open for Ash, not decided here:** whether issuing a 发票 (upload and Mark issued) should be
   `invoices:manage` only. If yes, both this rule and the `/orders/:id/invoice` rule narrow
   together, and the desktop drawer's upload button should gain a `data-cap`.
4. **Nothing changes** for the owner, for a shop with enforcement off, or while an operator's
   permissions cannot be resolved.
5. **Tests.** `scripts/test_invoice_file_gate.js` (fast shard, 21 checks): the rule and its
   exact path, neighbouring routes unchanged, who gets through (either key, the owner,
   enforcement off, unresolved permissions) and who is refused (invoice read-only, orders
   read-only, nothing held), through a copy of the permission check that is itself checked
   against `routes/retail.js`, and that the two callers are the only callers.
