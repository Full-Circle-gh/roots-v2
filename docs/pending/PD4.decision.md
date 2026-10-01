## §NEW — A SHOP MENU'S DAILY EDITS COME TO THE PHONE

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
The read-only Shop menu screens from PD2 gained the desktop's daily writes,
each behind `stores:edit` as on the desktop. A row's switch makes the
listing available or not. Tapping a row opens a sheet for its price and kind
(Stocked / Made here) and for Remove. **+ Add product** opens a picker that
searches the shop's candidates and adds one at a time, with the desktop's
**Add all N Online store products**. Each write is the desktop's request:
`PATCH /shops/:id/listings/:lid` (`{is_available}`, `{price}`,
`{fulfilment_mode}`), `DELETE /shops/:id/listings/:lid`,
`GET /shops/:id/candidates?q=`, `POST /shops/:id/listings
{store_product_id}`, `POST /shops/:id/listings/add-published`. Creating a
shop, renaming it, switching it on and off, and moving its products stay for
PD13.

1. **Without `stores:edit` the menu is exactly PD2's read-only screen**: no
   switch, no row sheet, no + Add product, and each command refuses. The
   server's `requireStoresEdit` is unchanged.
2. **Available is the row's switch, as on the desktop**: it flips at once,
   sends `{is_available: 1|0}`, takes the server's row, and if refused flips
   back and says why above the list (the refusal stays; a toast never reports
   a failure).
3. **Price and kind share one sheet, and Save sends one PATCH per field that
   changed**: the desktop's body, `{price}` or `{fulfilment_mode}`, with
   `price` sent as typed, as the desktop's input sends it. Nothing changed
   sends nothing. A price that is not a number of 0 or more is refused in the
   sheet before anything is sent, using the phone's existing price sentence;
   the server's `bad_price` gives the same sentence.
4. **Remove asks first, though the desktop does not** (the §325 survey's
   defect 14). The desktop's reasoning was that a listing is only a join and
   adding the product back restores it. But the price and kind set on that
   listing do not come back, so a stray tap on a phone costs something. The
   confirm names the product. The desktop's own Remove is unchanged.
5. **The picker is the desktop's panel as a sheet**: the search waits for a
   220 ms pause, the last search asked wins, and only the list under the box
   repaints, so the keyboard stays. A product added leaves the picker and
   joins the menu, and the picker stays open for the next one. **Add all**
   shows while the unfiltered answer counts Online store products this menu
   lacks, keeps its count while a search narrows the list, asks the desktop's
   question (count first, the §47 caveat in the body), and afterwards
   re-reads the count from the server rather than working it out on the
   phone.
6. **Back closes the row sheet and the picker before the menu, but not while
   a write from them is in flight.**
