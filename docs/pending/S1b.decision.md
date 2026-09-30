## §NEW — EVERY PHONE CONTROL IS DRAWN ONLY FOR WHO THE SERVER WILL LET PRESS IT, AND REFUSES FOR ANYONE ELSE

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
Live defect 2 of the whole-app survey (`docs/tacet-phone-parity-rest-of-app.md`): the order actions
and refunds, the product sheet's Save and switches, the coupon switch, the inbox's moderation, media
upload and broadcast cancel were drawn for every account, whatever it held. Each is now drawn for the
key the server actually requires — read from `lib/cap-routes.js` and the handlers, not from the
brief's guesses — and each command refuses on the same key, so a sheet left open, or a stale button,
cannot write past the gate (the §301 pattern). Phone only; no server change. `mCan`'s rule is
unchanged: while an operator's caps are still loading these keys read as held, and the server stays
the gate (§301.5–6; none of them is a money-only key).

1. **The order sheet, on two keys.** Every `/orders/…` write is `orders:edit` at the choke point;
   every `/refund…` path is `orders:refund`; a FULL refund goes through `PATCH …/status` and the
   handler also demands `orders:refund` (audit K-01), so it needs both.
   - The action row: Mark paid, the forward step and Reprint need `orders:edit`. Without it the row
     is not drawn at all unless "…" has something to offer.
   - The More sheet: Mark dispatched, Cancel / Cancel + refund, both undos and Shop note need
     `orders:edit`; Refund, Approve / Reject refund and Pay the refund need `orders:refund`. Refund
     offers **Full** only to somebody who also holds `orders:edit`; **Part** (`/refund/direct`) is
     `orders:refund` alone.
   - **Also gated, because the same map says so, though the brief did not list them:** Reprint
     (`POST …/print`), the parcel buttons (prepare, dispatch, undo, combine, split), Save / Clear /
     Retry tracking, the arrival time, the courier-could-not-reach card, the delivery photo's Add /
     Replace / ×, the late-parcel case's steps, evidence and Mark handled, and the shop note (a
     stored note is shown as text, with no box). Every one of them is an `orders:edit` write that
     a view-only account was offered and the server refuses. Reading all of it stays open.
2. **The product sheet.** Price, the catalogue's *In shop* switch (`/products/family-publish`),
   supplier pause and the out-of-stock policy are `products:edit`. A shelf count is any of
   `quickstock:recount`, `quickstock:add`, `products:edit` — the server's any-of, because Quick Stock
   and the stock modal share the route. So a stock-only account gets the steppers and Save, with
   the price shown as text and the policy read-only, and its Save sends only counts; an account
   with neither reads everything and presses nothing. Where a switch goes, its state is said in
   the switch's own words (*On the shop / Off the shop*, *Paused / Available*).
3. **The inbox.** Every `/reviews` write (hide, restore, reply) is `reviews:moderate`; every
   `/feedback` write (reply, handled, put back) is `feedback:moderate`. The row draws each button
   on its own stream's key. A feedback thread is still worth reading without the key, so its button
   becomes **View** and the thread opens with no box and no Send; a review has nothing more to read.
4. **Coupons, broadcasts, media.** The coupon switch is `coupons:edit` (`PATCH /vouchers/:id`; the
   card says On / Off without it). Cancel send is `broadcasts:send`. Add photos is `media:upload`.
5. **Deliberately not done here.** The category banner editor (§298) writes `PUT /category-tree`
   (`categories:edit`) and `/media/upload` (`media:upload`) and is drawn for everyone; it belongs
   with the category lane and defect 11's version check, and is reported rather than fixed. The
   media library's empty-state sentence still says "Add photos from this phone" to an account that
   now has no Add photos; it is a sentence, not a control, and is left for the content lane.
6. **Nothing composed.** Five live phone pairs are reused where a control gave way to a reading;
   `docs/pending/S1b.vocab.md` lists them.
7. **Tests.** `scripts/test_mobile_controls_gated.js` (fast shard, 33 checks) reads the keys from
   `lib/cap-routes.js` itself, then renders the order row, More sheet, tracking, arrival time,
   courier, photo, delay steps, shop note, product sheet, stock card, reply sheet and runs the
   commands under each combination of keys: what is drawn, that nothing is sent without the key,
   and with it the exact request (path, method, body). A static check confirms every order-sheet
   write command starts with its guard. `scripts/test_mobile_refusal_not_logout.js` gained an
   `mCan` stub, since the review switch it drives now asks.
