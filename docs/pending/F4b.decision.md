## §NEW — UPLOADING A 发票 FILE NEEDS `invoices:manage` ON THE SERVER

**Built 2026-09-30 under §300** (Ash: *"yes , and keep going until you finish all .I approve all"*).
Found while building F4. `POST /api/retail-admin/invoice-file` stores the PDF or photo of an
issued fapiao and returns the address that Mark issued then attaches to the order. It matched
no rule in `lib/cap-routes.js`, because `invoice-file` does not start with `invoices`, so it
was an unmapped write and fell through open: any signed-in operator could store a file there,
whether or not enforcement was on. It is now gated on `invoices:manage`, which the role editor
labels "Issue / upload invoices" — this act by name.

1. **Every caller was checked first.** There are exactly two: the desktop order drawer's
   PDF / image button (`07-content-billing.js`, `uploadInvoicePdf`) and the phone order
   sheet's (`m.html`, `invFile`, F4). The phone already shows its button, and runs its
   command, only for `invoices:manage` (together with `orders:edit`). No other surface calls
   the route.
2. **Who this newly refuses.** On a shop with enforcement on, the `staff` and `dispatch`
   presets hold `orders:edit` without `invoices:manage`. The desktop showed them the upload
   button and the server accepted the upload. The role editor has always said those accounts
   may not upload invoices, so this is the refusal that permission always described, not a new
   limit on anyone's job. For that reason there is no list of alternative keys. Nothing changes
   for the owner, for a shop with enforcement off, or while an operator's permissions cannot be
   resolved.
3. **Deliberately not changed:**
   - Mark issued (`PUT /orders/:id/invoice`) stays under the `/orders` rule (`orders:edit`).
     Narrowing it to `invoices:manage` too would stop `staff` and `dispatch` from issuing with
     a pasted link or number, which they can do today. That is Ash's decision to make, and it
     is recorded here as open.
   - The desktop drawer's upload button still shows for everyone. It gains no `data-cap` in
     this step, so an account without the key now sees the server's refusal in a toast.
4. **Tests.** `scripts/test_invoice_file_gate.js` (fast shard) checks:
   - the rule itself: reads stay open, the path must match exactly, and the neighbouring
     routes are unchanged;
   - who gets through (the key, the phone's pair, the owner, enforcement off, unresolved
     permissions) and who is refused (`orders:edit` alone, invoice read-only, nothing held),
     through a copy of the permission check that is itself checked against `routes/retail.js`;
   - that the two callers are the only callers.
