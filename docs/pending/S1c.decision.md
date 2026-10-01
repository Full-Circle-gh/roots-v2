## §NEW — THE DESKTOP'S GUARDS COME TO THE PHONE: THE RIDER WARNING, WHOLE POINTS, THE FAMILY'S POLICY, THE RECOUNT QUESTIONS, THE PUBLISH CHECK

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
Live defects 5–10, 12 and 13 of the whole-app survey (`docs/tacet-phone-parity-rest-of-app.md`).
Each is a write the phone made without the check the desktop puts in front of the same write, or a
small state or wording defect. Phone only (`public/m.html`); no server change. Every guard is the
desktop's own, read from its module and carried across with its words.

1. **Approve refund names the rider (§222).** The phone's approve sheet now carries the desktop's
   *A rider is on this order right now — approving cancels that delivery.* when a same-city rider
   is in flight (`awaiting_dispatch`, `heading_to_pickup`, `in_transit`; not `cancelled`) and the
   approve is FULL. "Full" is the server's own test, as on the desktop: the amount the server will
   take (the customer's picked lines, else the amount asked, else the order total), capped at what
   is left, against the remaining GROSS tenders (points + wallet + cash, less any prior approval) —
   not the cash total. The detail map now carries that gross figure. **Decided:** when the detail
   read has not landed and the figures are unknown, the sentence is shown; a warning that turns
   out not to apply costs a second's reading, a rider pulled unwarned costs the delivery. The
   rest of §222's block (the full/partial consequence line, "refunding never changes the delivery
   day") is not added: the phone's approve takes no amount of its own, and the survey asked for
   the rider warning. It is noted for the Orders lane.
2. **Points adjust is whole, never rounded.** It read `parseInt`, so "1.5" saved 1 and "12abc"
   saved 12. It now reads `Number()` as the desktop's `cuSaveAdjust` does, refuses a fraction
   with the desktop's *Points must be a whole number.*, and sends the number read.
3. **The out-of-stock policy goes to the whole family.** The desktop's Save sends it to every
   size (`vaPersistSiblings(oosPolicy)`); the phone's picker changed the size on screen only. It
   now writes the size on screen first, then each sibling whose policy differs, one
   `PATCH /products/:id {oos_policy}` each. A failure part-way puts back only the sizes that did
   not land and says *Some sizes did not save. Pick it again to finish.* (composed, declared);
   picking again sends only what is still behind.
4. **The two recount refusals are asked and answered.** `recount_clears_debt` (§84, a shelf below
   zero) and `recount_reason_required` (§46, a kitchen count gone down) used to show the server's
   English sentence in the row and stop, so a shelf at −18 could not be corrected from the phone
   by any number. Add stock (both its modes) and the product sheet's Save now ask the desktop's
   questions (`09-products.js _paAskRecountReason`) word for word and resend the same count with
   `recount_reason: clears_debt | miscount`. Asked once: a refusal of the answered write is
   reported. Backing out puts the shelf's own number back; *Something is missing or spoiled* says
   the desktop's *The count stays as it is. Tell whoever records waste.*
5. **Reopening a channel at a shop reads what it will publish first.** After the phone's own
   confirm, an open now reads `GET /channel-status/reopen-preview` (3-second leash, as the
   desktop's `csCell`) and, when anything would be published, asks the desktop's *Publish current
   stock to this channel?* with the oldest figures listed and *Publish / Not yet*. Nothing to
   publish, or a preview that fails, goes straight to the write, as there. The ask sheet gained an
   optional `cancelLabel` so *Not yet* can be said. Closing reads nothing.
6. **Needs you follows the store lock.** `GET /dashboard/ops` now carries `store_id` for a
   store-scoped operator, as the desktop's `dashStoreQS` does. With no lock nothing is added.
   (Whether the server honours a store on every count is S2's defect 4, not this.)
7. **Resume delivery is a version.** It writes `PUT /config?history=delivery.holiday`, the
   desktop Holiday card's history key, with the card's same two keys — `holidayMode:false` and the
   stored `holidayMessage`, unchanged — because the server records exactly the keys it is sent.
   A message the phone never read is left out rather than sent blank.
8. **Legal and FAQ keep separate open rows.** Legal had used `faqToggle` / `state.faqOpen`, so
   an FAQ answer left open opened the legal document with the same index. It has `legalToggle` /
   `state.legalOpen` now.
9. **Notes that were no longer true.**
   - Invoices: *Issue fapiao on desktop* is gone; each request row opens its order's sheet
     (`openInvoiceOrder`, the `openDeliveryAlert` shape), where §314 issues the fapiao.
   - Operations: *staff* comes out of *Store details, staff, printers and payment keys are set on
     desktop.* — the phone's Team screen does staff.
   - An order's verified payment screenshot no longer says *Marking it paid is a desktop action* —
     the phone's Mark paid asks for the tender.
   - **Left as they are, deliberately:** the Editor's "published on desktop" (the phone page
     editor exists, but this app has no door to it yet — that door is the Page editor lane), and
     Setup's wizard note (the phone does none of those steps).
10. **Tests.** `scripts/test_mobile_safety_guards.js` (fast shard, 37 checks) runs each path with
    a fake server and asserts every request (path, method, body) and every sentence against the
    desktop's own file. `scripts/test_fapiao_no_auto_issue.js` pinned the Invoices line; it now
    pins that the line is gone and rows open the order. `scripts/test_mobile_settings.js` (slow
    shard, not run here) opened a legal document through `state.faqOpen`; it now uses
    `state.legalOpen` and gains a case that an open FAQ answer does not open a document.
