## §NEW — A PRODUCT CAN BE DUPLICATED, AND ONE OF ITS VERSIONS RESTORED, FROM THE PHONE

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
Two desktop actions reached the phone. The Version history list PD2 made
read-only now offers **Restore** on every version except the newest. The
product sheet gains **Duplicate**. Each sends the desktop's request:
`POST /products/:id/restore-version {version_id}` behind the desktop's
confirm, and `POST /products/:id/duplicate {as_variant: false, label: null}`,
the only form the desktop's two Duplicate buttons send.

1. **Restore is gated on `products:edit`**, the key the server maps the
   restore to. A reader keeps PD2's read-only list. The newest version
   carries no Restore (it is what the product already is), and the desktop's
   line saying what Restore does ("…Stock counts are never changed") heads
   the list only for someone who can use it.
2. **The confirm is the desktop's, word for word**, and nothing is sent before
   it is answered. While it runs, the row says so and the list cannot be
   closed. Success closes the list with the desktop's toast, and the
   catalogue is read again so the sheet and the list show the restored
   product. A refusal stays in the list, never in a toast.
3. **Edits still waiting on the Details screen are saved before the restore,
   never after.** A pending autosave that landed after the restore would put
   the edit back over the version just chosen. So the restore waits for that
   save, and afterwards the Details screen reads the product again.
4. **Duplicate is gated on `products:create`**, the key the server gives a
   duplicate because it creates a product. It is not offered on an upstream
   catalogue, which the server refuses (`catalog_locked`). The desktop's
   Duplicate carries no `data-cap` at all; the phone draws no button the
   server would refuse.
5. **No confirm on Duplicate, as on the desktop**: nothing that exists changes.
   The copy joins the catalogue and opens for tweaking, with the desktop's
   reminder to set the new SKU, price and size. An editor gets the copy's
   Details screen; a creator who may not edit gets its sheet. A failure is
   said on the sheet.
6. **Not built:** "Duplicate as a size of this product" (`as_variant: true`
   with a label). The endpoint takes it, but no desktop control sends it, so
   it is not a desktop capability to match. Sizes are PD9's.
